//! int8 transformer sentence encoders in WebAssembly SIMD, plus an int8 vector
//! scan of any dimension. Used for the models added next to LEALLA-large
//! (which has its own, frozen module in `wasm/`):
//!
//!   * intfloat/multilingual-e5-small: BERT (absolute positions, post-LN,
//!     GELU FFN), mean pooling
//!   * Snowflake/snowflake-arctic-embed-m-v2.0: GTE (rotary positions, packed
//!     QKV, post-LN, gated GELU FFN), CLS pooling, Matryoshka truncation
//!
//! Every linear layer runs in int8: weights are quantised per output channel
//! (offline), activations per token (here, on the fly), products are
//! accumulated in i32 and rescaled. Attention, softmax, LayerNorm and the
//! activations stay in f32.
//!
//! The host (JS) allocates every tensor with `alloc_bytes`, fills it, and
//! passes a table of sizes and pointers to `init` (layout in `Cfg`). Word
//! embeddings are looked up by the host, which writes T rows of H floats at
//! `input_ptr()` before calling `embed`.

#![no_std]

extern crate alloc;

use alloc::vec::Vec;
use core::arch::wasm32::*;

#[global_allocator]
static ALLOC: Bump = Bump;

/// Minimal allocator: grows linear memory, never frees (buffers are allocated
/// once and reused).
struct Bump;

static mut HEAP_TOP: usize = 0;

unsafe impl core::alloc::GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: core::alloc::Layout) -> *mut u8 {
        let align = layout.align().max(16);
        if HEAP_TOP == 0 {
            extern "C" {
                static __heap_base: u8;
            }
            HEAP_TOP = &__heap_base as *const u8 as usize;
        }
        let start = (HEAP_TOP + align - 1) & !(align - 1);
        let end = start + layout.size();
        let have = memory_size(0) * 65536;
        if end > have {
            let pages = (end - have + 65535) / 65536;
            if memory_grow(0, pages) == usize::MAX {
                return core::ptr::null_mut();
            }
        }
        HEAP_TOP = end;
        start as *mut u8
    }
    unsafe fn dealloc(&self, _ptr: *mut u8, _layout: core::alloc::Layout) {}
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

fn buf<T: Copy + Default>(n: usize) -> Vec<T> {
    let mut v = Vec::with_capacity(n);
    v.resize(n, T::default());
    v
}

/// Allocate `bytes` bytes (16-byte aligned) in linear memory for the host.
#[no_mangle]
pub extern "C" fn alloc_bytes(bytes: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(bytes.max(16));
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

// ------------------------------------------------------------------ config

const FLAG_GATED: u32 = 1; // FFN = down(gelu(gate) * up), up_gate packed as [up; gate]
const FLAG_ROPE: u32 = 2; // rotary position embeddings on Q and K
const FLAG_ABS_POS: u32 = 4; // learned absolute position embeddings

#[allow(dead_code)]
const POOL_MEAN: u32 = 0;
const POOL_CLS: u32 = 1;

/// One layer: pointers into linear memory. Weights are int8 [out, in] with
/// one f32 scale per output row; biases may be null.
#[derive(Clone, Copy)]
struct Layer {
    qkv_w: *const i8,
    qkv_s: *const f32,
    qkv_b: *const f32,
    o_w: *const i8,
    o_s: *const f32,
    o_b: *const f32,
    ln1_g: *const f32,
    ln1_b: *const f32,
    up_w: *const i8,
    up_s: *const f32,
    up_b: *const f32,
    down_w: *const i8,
    down_s: *const f32,
    down_b: *const f32,
    ln2_g: *const f32,
    ln2_b: *const f32,
}

const LAYER_WORDS: usize = 16;
const HEADER_WORDS: usize = 14;

/// Host table (u32 words):
///   0 flags, 1 hidden, 2 heads, 3 ffn, 4 layers, 5 max_tokens, 6 pooling,
///   7 out_dim, 8 ln_eps (f32 bits), 9 rope_theta (f32 bits),
///   10 token_type_row0 [H], 11 position embeddings [max_t, H] (or 0),
///   12 emb_ln_g, 13 emb_ln_b, then LAYER_WORDS per layer (see `Layer`).
struct Cfg {
    flags: u32,
    h: usize,
    heads: usize,
    hd: usize,
    ff: usize,
    max_t: usize,
    pooling: u32,
    out_dim: usize,
    eps: f32,
    tt0: *const f32,
    pos: *const f32,
    emb_g: *const f32,
    emb_b: *const f32,
    layers: Vec<Layer>,
    rope_cos: Vec<f32>, // [max_t, hd/2]
    rope_sin: Vec<f32>,
}

struct Scratch {
    x: Vec<f32>,    // [T, H] hidden state
    qkv: Vec<f32>,  // [T, 3H]
    ctx: Vec<f32>,  // [T, H]
    tmp: Vec<f32>,  // [T, H]
    ff: Vec<f32>,   // [T, FF or 2FF]
    act: Vec<f32>,  // [T, FF]
    xq: Vec<i16>,   // [T, max(H, FF)] quantised activations (widened to i16)
    xs: Vec<f32>,   // [T] activation scales
    qh: Vec<f32>,   // [T, HD] per-head Q
    kh: Vec<f32>,   // [T, HD]
    vt: Vec<f32>,   // [HD, T]
    scores: Vec<f32>, // [T, T]
    pooled: Vec<f32>, // [H]
}

static mut CFG: Option<Cfg> = None;
static mut SCRATCH: Option<Scratch> = None;

#[no_mangle]
pub unsafe extern "C" fn init(table: *const u32) -> i32 {
    let w = |i: usize| *table.add(i);
    let p = |i: usize| *table.add(i) as usize;
    let h = p(1);
    let heads = p(2);
    let ff = p(3);
    let n_layers = p(4);
    let max_t = p(5);
    let flags = w(0);
    if h == 0 || heads == 0 || h % heads != 0 || h % 16 != 0 || ff % 16 != 0 || max_t == 0 {
        return -1;
    }
    let hd = h / heads;
    let mut layers = Vec::with_capacity(n_layers);
    for l in 0..n_layers {
        let b = HEADER_WORDS + l * LAYER_WORDS;
        layers.push(Layer {
            qkv_w: p(b) as *const i8,
            qkv_s: p(b + 1) as *const f32,
            qkv_b: p(b + 2) as *const f32,
            o_w: p(b + 3) as *const i8,
            o_s: p(b + 4) as *const f32,
            o_b: p(b + 5) as *const f32,
            ln1_g: p(b + 6) as *const f32,
            ln1_b: p(b + 7) as *const f32,
            up_w: p(b + 8) as *const i8,
            up_s: p(b + 9) as *const f32,
            up_b: p(b + 10) as *const f32,
            down_w: p(b + 11) as *const i8,
            down_s: p(b + 12) as *const f32,
            down_b: p(b + 13) as *const f32,
            ln2_g: p(b + 14) as *const f32,
            ln2_b: p(b + 15) as *const f32,
        });
    }
    let mut rope_cos = Vec::new();
    let mut rope_sin = Vec::new();
    if flags & FLAG_ROPE != 0 {
        // Same computation as the reference: inv_freq and angles in f32
        let theta = f32::from_bits(w(9)) as f64;
        let half = hd / 2;
        rope_cos = buf(max_t * half);
        rope_sin = buf(max_t * half);
        for j in 0..half {
            let inv = (1.0 / pow64(theta, (2 * j) as f64 / hd as f64)) as f32;
            for t in 0..max_t {
                let a = ((t as f32) * inv) as f64;
                rope_cos[t * half + j] = cos64(a) as f32;
                rope_sin[t * half + j] = sin64(a) as f32;
            }
        }
    }
    let up_rows = if flags & FLAG_GATED != 0 { 2 * ff } else { ff };
    CFG = Some(Cfg {
        flags,
        h,
        heads,
        hd,
        ff,
        max_t,
        pooling: w(6),
        out_dim: p(7).min(h),
        eps: f32::from_bits(w(8)),
        tt0: p(10) as *const f32,
        pos: p(11) as *const f32,
        emb_g: p(12) as *const f32,
        emb_b: p(13) as *const f32,
        layers,
        rope_cos,
        rope_sin,
    });
    SCRATCH = Some(Scratch {
        x: buf(max_t * h),
        qkv: buf(max_t * 3 * h),
        ctx: buf(max_t * h),
        tmp: buf(max_t * h),
        ff: buf(max_t * up_rows),
        act: buf(max_t * ff),
        xq: buf(max_t * h.max(ff)),
        xs: buf(max_t),
        qh: buf(max_t * hd),
        kh: buf(max_t * hd),
        vt: buf(hd * max_t),
        scores: buf(max_t * max_t),
        pooled: buf(h),
    });
    0
}

/// Buffer where the host writes T word-embedding rows before calling `embed`.
#[no_mangle]
pub unsafe extern "C" fn input_ptr() -> *mut f32 {
    match (*core::ptr::addr_of_mut!(SCRATCH)).as_mut() {
        Some(s) => s.x.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

// ------------------------------------------------------------------ math

#[inline(always)]
fn hsum(v: v128) -> f32 {
    f32x4_extract_lane::<0>(v)
        + f32x4_extract_lane::<1>(v)
        + f32x4_extract_lane::<2>(v)
        + f32x4_extract_lane::<3>(v)
}

#[inline(always)]
fn hsum_i32(v: v128) -> i32 {
    i32x4_extract_lane::<0>(v)
        + i32x4_extract_lane::<1>(v)
        + i32x4_extract_lane::<2>(v)
        + i32x4_extract_lane::<3>(v)
}

#[inline(always)]
fn sqrtf(x: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_sqrt(f32x4_splat(x)))
}

/// Round half to even, like torch.round
#[inline(always)]
fn nearest(x: f32) -> f32 {
    f32x4_extract_lane::<0>(f32x4_nearest(f32x4_splat(x)))
}

/// exp(x) in f64 (no libm in no_std): range reduction + degree-13 Taylor.
fn exp64(x: f64) -> f64 {
    if x < -700.0 {
        return 0.0;
    }
    if x > 700.0 {
        return f64::INFINITY;
    }
    const LN2: f64 = core::f64::consts::LN_2;
    let kf = x / LN2;
    let k = if kf >= 0.0 { (kf + 0.5) as i64 } else { (kf - 0.5) as i64 };
    let r = x - (k as f64) * LN2;
    let mut term = 1.0f64;
    let mut sum = 1.0f64;
    let mut i = 1.0f64;
    while i < 14.0 {
        term *= r / i;
        sum += term;
        i += 1.0;
    }
    sum * f64::from_bits(((k + 1023) as u64) << 52)
}

/// ln(x), x > 0: mantissa/exponent split + atanh series
fn ln64(x: f64) -> f64 {
    let bits = x.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000); // [1, 2)
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let mut term = s;
    let mut sum = 0.0;
    let mut k = 1.0;
    while k < 60.0 {
        sum += term / k;
        term *= s2;
        k += 2.0;
    }
    2.0 * sum + (e as f64) * core::f64::consts::LN_2
}

fn pow64(b: f64, e: f64) -> f64 {
    exp64(e * ln64(b))
}

/// sin/cos in f64: reduction to [-pi, pi], Taylor to degree ~25
fn sin64(x: f64) -> f64 {
    const TAU: f64 = core::f64::consts::TAU;
    const PI: f64 = core::f64::consts::PI;
    let mut r = x - TAU * ((x / TAU) as i64 as f64);
    while r > PI {
        r -= TAU;
    }
    while r < -PI {
        r += TAU;
    }
    let r2 = r * r;
    let mut term = r;
    let mut sum = r;
    let mut n = 1.0;
    while n < 30.0 {
        term *= -r2 / ((n + 1.0) * (n + 2.0));
        sum += term;
        n += 2.0;
    }
    sum
}

fn cos64(x: f64) -> f64 {
    sin64(x + core::f64::consts::FRAC_PI_2)
}

/// Exact GELU: 0.5 x (1 + erf(x / sqrt 2)), erf with |error| < 1.2e-7
#[inline(always)]
fn gelu(x: f32) -> f32 {
    let z = (x as f64) * core::f64::consts::FRAC_1_SQRT_2;
    let a = if z < 0.0 { -z } else { z };
    let t = 1.0 / (1.0 + 0.5 * a);
    let y = t
        * exp64(
            -a * a - 1.265_512_23
                + t * (1.000_023_68
                    + t * (0.374_091_96
                        + t * (0.096_784_18
                            + t * (-0.186_288_06
                                + t * (0.278_868_07
                                    + t * (-1.135_203_98
                                        + t * (1.488_515_87 + t * (-0.822_152_23 + t * 0.170_872_77)))))))),
        );
    let erf = if z >= 0.0 { 1.0 - y } else { y - 1.0 };
    (0.5 * (x as f64) * (1.0 + erf)) as f32
}

#[inline(always)]
fn expf(x: f32) -> f32 {
    exp64(x as f64) as f32
}

// ------------------------------------------------------------------ kernels

/// Quantise `t` rows of `k` floats to int8 values (stored widened to i16),
/// one symmetric scale per row: q = round(x / s), s = max|x| / 127.
unsafe fn quantize_rows(x: *const f32, t: usize, k: usize, q: *mut i16, s: *mut f32) {
    for row in 0..t {
        let xr = x.add(row * k);
        let mut mx = f32x4_splat(0.0);
        let mut i = 0;
        while i < k {
            mx = f32x4_max(mx, f32x4_abs(v128_load(xr.add(i) as *const v128)));
            i += 4;
        }
        let amax = f32x4_extract_lane::<0>(mx)
            .max(f32x4_extract_lane::<1>(mx))
            .max(f32x4_extract_lane::<2>(mx))
            .max(f32x4_extract_lane::<3>(mx));
        let scale = if amax > 1e-12 { amax / 127.0 } else { 1e-12 / 127.0 };
        *s.add(row) = scale;
        let vs = f32x4_splat(scale);
        let lo = f32x4_splat(-127.0);
        let hi = f32x4_splat(127.0);
        let qr = q.add(row * k);
        let mut i = 0;
        while i < k {
            let a = f32x4_nearest(f32x4_div(v128_load(xr.add(i) as *const v128), vs));
            let b = f32x4_nearest(f32x4_div(v128_load(xr.add(i + 4) as *const v128), vs));
            let a = i32x4_trunc_sat_f32x4(f32x4_min(f32x4_max(a, lo), hi));
            let b = i32x4_trunc_sat_f32x4(f32x4_min(f32x4_max(b, lo), hi));
            v128_store(qr.add(i) as *mut v128, i16x8_narrow_i32x4(a, b));
            i += 8;
        }
    }
}

/// C[t, n] = (Xq[t] · W[n]) * xs[t] * ws[n] + bias[n]
/// Xq: [T, K] i16 (int8 range), W: [N, K] i8, K multiple of 16.
#[allow(clippy::too_many_arguments)]
unsafe fn gemm_i8(
    xq: *const i16,
    xs: *const f32,
    t: usize,
    w: *const i8,
    ws: *const f32,
    bias: *const f32,
    n: usize,
    k: usize,
    c: *mut f32,
    ldc: usize,
) {
    let mut j = 0;
    while j + 2 <= n {
        let w0 = w.add(j * k);
        let w1 = w.add((j + 1) * k);
        let mut i = 0;
        while i + 4 <= t {
            let x0 = xq.add(i * k);
            let x1 = xq.add((i + 1) * k);
            let x2 = xq.add((i + 2) * k);
            let x3 = xq.add((i + 3) * k);
            let z = i32x4_splat(0);
            let (mut a00, mut a01, mut a10, mut a11) = (z, z, z, z);
            let (mut a20, mut a21, mut a30, mut a31) = (z, z, z, z);
            let mut p = 0;
            while p < k {
                let v0 = v128_load(w0.add(p) as *const v128);
                let v1 = v128_load(w1.add(p) as *const v128);
                let w0l = i16x8_extend_low_i8x16(v0);
                let w0h = i16x8_extend_high_i8x16(v0);
                let w1l = i16x8_extend_low_i8x16(v1);
                let w1h = i16x8_extend_high_i8x16(v1);
                let xl = v128_load(x0.add(p) as *const v128);
                let xh = v128_load(x0.add(p + 8) as *const v128);
                a00 = i32x4_add(a00, i32x4_add(i32x4_dot_i16x8(xl, w0l), i32x4_dot_i16x8(xh, w0h)));
                a01 = i32x4_add(a01, i32x4_add(i32x4_dot_i16x8(xl, w1l), i32x4_dot_i16x8(xh, w1h)));
                let xl = v128_load(x1.add(p) as *const v128);
                let xh = v128_load(x1.add(p + 8) as *const v128);
                a10 = i32x4_add(a10, i32x4_add(i32x4_dot_i16x8(xl, w0l), i32x4_dot_i16x8(xh, w0h)));
                a11 = i32x4_add(a11, i32x4_add(i32x4_dot_i16x8(xl, w1l), i32x4_dot_i16x8(xh, w1h)));
                let xl = v128_load(x2.add(p) as *const v128);
                let xh = v128_load(x2.add(p + 8) as *const v128);
                a20 = i32x4_add(a20, i32x4_add(i32x4_dot_i16x8(xl, w0l), i32x4_dot_i16x8(xh, w0h)));
                a21 = i32x4_add(a21, i32x4_add(i32x4_dot_i16x8(xl, w1l), i32x4_dot_i16x8(xh, w1h)));
                let xl = v128_load(x3.add(p) as *const v128);
                let xh = v128_load(x3.add(p + 8) as *const v128);
                a30 = i32x4_add(a30, i32x4_add(i32x4_dot_i16x8(xl, w0l), i32x4_dot_i16x8(xh, w0h)));
                a31 = i32x4_add(a31, i32x4_add(i32x4_dot_i16x8(xl, w1l), i32x4_dot_i16x8(xh, w1h)));
                p += 16;
            }
            let acc = [[a00, a01], [a10, a11], [a20, a21], [a30, a31]];
            for (r, row) in acc.iter().enumerate() {
                for (cc, a) in row.iter().enumerate() {
                    let jj = j + cc;
                    let b = if bias.is_null() { 0.0 } else { *bias.add(jj) };
                    *c.add((i + r) * ldc + jj) = (hsum_i32(*a) as f32) * *xs.add(i + r) * *ws.add(jj) + b;
                }
            }
            i += 4;
        }
        while i < t {
            for jj in j..j + 2 {
                *c.add(i * ldc + jj) = dot_i8(xq.add(i * k), w.add(jj * k), k) * *xs.add(i) * *ws.add(jj)
                    + if bias.is_null() { 0.0 } else { *bias.add(jj) };
            }
            i += 1;
        }
        j += 2;
    }
    while j < n {
        for i in 0..t {
            *c.add(i * ldc + j) = dot_i8(xq.add(i * k), w.add(j * k), k) * *xs.add(i) * *ws.add(j)
                + if bias.is_null() { 0.0 } else { *bias.add(j) };
        }
        j += 1;
    }
}

#[inline(always)]
unsafe fn dot_i8(x: *const i16, w: *const i8, k: usize) -> f32 {
    let mut acc = i32x4_splat(0);
    let mut p = 0;
    while p < k {
        let v = v128_load(w.add(p) as *const v128);
        acc = i32x4_add(acc, i32x4_dot_i16x8(v128_load(x.add(p) as *const v128), i16x8_extend_low_i8x16(v)));
        acc = i32x4_add(acc, i32x4_dot_i16x8(v128_load(x.add(p + 8) as *const v128), i16x8_extend_high_i8x16(v)));
        p += 16;
    }
    hsum_i32(acc) as f32
}

/// f32 C[m, n] = sum_k A[m, k] * B[n, k]  (row strides lda, ldb, ldc)
#[allow(clippy::too_many_arguments)]
unsafe fn gemm_nt(a: *const f32, lda: usize, b: *const f32, ldb: usize, c: *mut f32, ldc: usize, m: usize, n: usize, k: usize) {
    let k4 = k & !3;
    let mut i = 0;
    while i + 2 <= m {
        let a0 = a.add(i * lda);
        let a1 = a.add((i + 1) * lda);
        let mut j = 0;
        while j + 4 <= n {
            let b0 = b.add(j * ldb);
            let b1 = b.add((j + 1) * ldb);
            let b2 = b.add((j + 2) * ldb);
            let b3 = b.add((j + 3) * ldb);
            let z = f32x4_splat(0.0);
            let (mut c00, mut c01, mut c02, mut c03) = (z, z, z, z);
            let (mut c10, mut c11, mut c12, mut c13) = (z, z, z, z);
            let mut p = 0;
            while p < k4 {
                let va0 = v128_load(a0.add(p) as *const v128);
                let va1 = v128_load(a1.add(p) as *const v128);
                let vb0 = v128_load(b0.add(p) as *const v128);
                let vb1 = v128_load(b1.add(p) as *const v128);
                let vb2 = v128_load(b2.add(p) as *const v128);
                let vb3 = v128_load(b3.add(p) as *const v128);
                c00 = f32x4_add(c00, f32x4_mul(va0, vb0));
                c01 = f32x4_add(c01, f32x4_mul(va0, vb1));
                c02 = f32x4_add(c02, f32x4_mul(va0, vb2));
                c03 = f32x4_add(c03, f32x4_mul(va0, vb3));
                c10 = f32x4_add(c10, f32x4_mul(va1, vb0));
                c11 = f32x4_add(c11, f32x4_mul(va1, vb1));
                c12 = f32x4_add(c12, f32x4_mul(va1, vb2));
                c13 = f32x4_add(c13, f32x4_mul(va1, vb3));
                p += 4;
            }
            let mut r = [
                [hsum(c00), hsum(c01), hsum(c02), hsum(c03)],
                [hsum(c10), hsum(c11), hsum(c12), hsum(c13)],
            ];
            while p < k {
                let av = [*a0.add(p), *a1.add(p)];
                let bv = [*b0.add(p), *b1.add(p), *b2.add(p), *b3.add(p)];
                for (ri, row) in r.iter_mut().enumerate() {
                    for (ci, cell) in row.iter_mut().enumerate() {
                        *cell += av[ri] * bv[ci];
                    }
                }
                p += 1;
            }
            for (ri, row) in r.iter().enumerate() {
                for (ci, cell) in row.iter().enumerate() {
                    *c.add((i + ri) * ldc + j + ci) = *cell;
                }
            }
            j += 4;
        }
        while j < n {
            *c.add(i * ldc + j) = dot(a0, b.add(j * ldb), k);
            *c.add((i + 1) * ldc + j) = dot(a1, b.add(j * ldb), k);
            j += 1;
        }
        i += 2;
    }
    while i < m {
        for j in 0..n {
            *c.add(i * ldc + j) = dot(a.add(i * lda), b.add(j * ldb), k);
        }
        i += 1;
    }
}

#[inline(always)]
unsafe fn dot(a: *const f32, b: *const f32, k: usize) -> f32 {
    let mut acc = f32x4_splat(0.0);
    let mut p = 0;
    while p + 4 <= k {
        acc = f32x4_add(acc, f32x4_mul(v128_load(a.add(p) as *const v128), v128_load(b.add(p) as *const v128)));
        p += 4;
    }
    let mut s = hsum(acc);
    while p < k {
        s += *a.add(p) * *b.add(p);
        p += 1;
    }
    s
}

/// x = LayerNorm(x + r) row by row (r may be null)
unsafe fn add_layer_norm(x: *mut f32, r: *const f32, t: usize, h: usize, g: *const f32, b: *const f32, eps: f32) {
    for row in 0..t {
        let xr = x.add(row * h);
        if !r.is_null() {
            let rr = r.add(row * h);
            for i in 0..h {
                *xr.add(i) += *rr.add(i);
            }
        }
        let mut mean = 0.0f32;
        for i in 0..h {
            mean += *xr.add(i);
        }
        mean /= h as f32;
        let mut var = 0.0f32;
        for i in 0..h {
            let d = *xr.add(i) - mean;
            var += d * d;
        }
        var /= h as f32;
        let inv = 1.0 / sqrtf(var + eps);
        for i in 0..h {
            *xr.add(i) = (*xr.add(i) - mean) * inv * *g.add(i) + *b.add(i);
        }
    }
}

/// Rotate one head's [T, HD] rows in place (rotate_half convention)
unsafe fn apply_rope(x: *mut f32, t: usize, hd: usize, cos: &[f32], sin: &[f32]) {
    let half = hd / 2;
    for row in 0..t {
        let xr = x.add(row * hd);
        for j in 0..half {
            let c = cos[row * half + j];
            let s = sin[row * half + j];
            let a = *xr.add(j);
            let b = *xr.add(j + half);
            *xr.add(j) = a * c - b * s;
            *xr.add(j + half) = b * c + a * s;
        }
    }
}

// ------------------------------------------------------------------ forward

/// Run the encoder on `t` tokens whose word embeddings the host wrote at
/// `input_ptr()`. Writes the first `out_dim` pooled values, L2-normalised,
/// to `out`. Returns 0 on success.
#[no_mangle]
pub unsafe extern "C" fn embed(t: usize, out: *mut f32) -> i32 {
    let cfg = match (*core::ptr::addr_of!(CFG)).as_ref() {
        Some(c) => c,
        None => return -1,
    };
    let s = (*core::ptr::addr_of_mut!(SCRATCH)).as_mut().unwrap();
    if t == 0 || t > cfg.max_t {
        return -2;
    }
    let h = cfg.h;
    let hd = cfg.hd;
    let ff = cfg.ff;
    let gated = cfg.flags & FLAG_GATED != 0;
    let rope = cfg.flags & FLAG_ROPE != 0;
    let x = s.x.as_mut_ptr();

    // embeddings: word (+ token type 0) (+ absolute position), LayerNorm
    for row in 0..t {
        for i in 0..h {
            let mut v = *x.add(row * h + i) + *cfg.tt0.add(i);
            if cfg.flags & FLAG_ABS_POS != 0 {
                v += *cfg.pos.add(row * h + i);
            }
            *x.add(row * h + i) = v;
        }
    }
    add_layer_norm(x, core::ptr::null(), t, h, cfg.emb_g, cfg.emb_b, cfg.eps);

    let att_scale = 1.0 / sqrtf(hd as f32);
    let xq = s.xq.as_mut_ptr();
    let xs = s.xs.as_mut_ptr();
    for l in cfg.layers.iter() {
        // Q, K, V in one int8 GEMM ([3H, H] weights)
        quantize_rows(x, t, h, xq, xs);
        gemm_i8(xq, xs, t, l.qkv_w, l.qkv_s, l.qkv_b, 3 * h, h, s.qkv.as_mut_ptr(), 3 * h);

        for head in 0..cfg.heads {
            let off = head * hd;
            for row in 0..t {
                let src = s.qkv.as_ptr().add(row * 3 * h);
                for d in 0..hd {
                    s.qh[row * hd + d] = *src.add(off + d);
                    s.kh[row * hd + d] = *src.add(h + off + d);
                    s.vt[d * t + row] = *src.add(2 * h + off + d);
                }
            }
            if rope {
                apply_rope(s.qh.as_mut_ptr(), t, hd, &cfg.rope_cos, &cfg.rope_sin);
                apply_rope(s.kh.as_mut_ptr(), t, hd, &cfg.rope_cos, &cfg.rope_sin);
            }
            gemm_nt(s.qh.as_ptr(), hd, s.kh.as_ptr(), hd, s.scores.as_mut_ptr(), t, t, t, hd);
            for row in 0..t {
                let sr = &mut s.scores[row * t..(row + 1) * t];
                let mut mx = f32::NEG_INFINITY;
                for v in sr.iter_mut() {
                    *v *= att_scale;
                    if *v > mx {
                        mx = *v;
                    }
                }
                let mut sum = 0.0f32;
                for v in sr.iter_mut() {
                    *v = expf(*v - mx);
                    sum += *v;
                }
                let inv = 1.0 / sum;
                for v in sr.iter_mut() {
                    *v *= inv;
                }
            }
            gemm_nt(s.scores.as_ptr(), t, s.vt.as_ptr(), t, s.ctx.as_mut_ptr().add(off), h, t, hd, t);
        }
        quantize_rows(s.ctx.as_ptr(), t, h, xq, xs);
        gemm_i8(xq, xs, t, l.o_w, l.o_s, l.o_b, h, h, s.tmp.as_mut_ptr(), h);
        add_layer_norm(x, s.tmp.as_ptr(), t, h, l.ln1_g, l.ln1_b, cfg.eps);

        // FFN
        quantize_rows(x, t, h, xq, xs);
        let act = if gated {
            gemm_i8(xq, xs, t, l.up_w, l.up_s, l.up_b, 2 * ff, h, s.ff.as_mut_ptr(), 2 * ff);
            for row in 0..t {
                let r = s.ff.as_ptr().add(row * 2 * ff);
                for i in 0..ff {
                    // [up | gate]: gelu(gate) * up
                    s.act[row * ff + i] = gelu(*r.add(ff + i)) * *r.add(i);
                }
            }
            s.act.as_ptr()
        } else {
            gemm_i8(xq, xs, t, l.up_w, l.up_s, l.up_b, ff, h, s.ff.as_mut_ptr(), ff);
            for v in s.ff[..t * ff].iter_mut() {
                *v = gelu(*v);
            }
            s.ff.as_ptr()
        };
        quantize_rows(act, t, ff, xq, xs);
        gemm_i8(xq, xs, t, l.down_w, l.down_s, l.down_b, h, ff, s.tmp.as_mut_ptr(), h);
        add_layer_norm(x, s.tmp.as_ptr(), t, h, l.ln2_g, l.ln2_b, cfg.eps);
    }

    // pooling
    let pooled = &mut s.pooled;
    if cfg.pooling == POOL_CLS {
        for i in 0..h {
            pooled[i] = *x.add(i);
        }
    } else {
        for i in 0..h {
            pooled[i] = 0.0;
        }
        for row in 0..t {
            for i in 0..h {
                pooled[i] += *x.add(row * h + i);
            }
        }
        let inv = 1.0 / t as f32;
        for v in pooled.iter_mut() {
            *v *= inv;
        }
    }
    let d = cfg.out_dim;
    let mut ss = 0.0f32;
    for v in pooled[..d].iter() {
        ss += v * v;
    }
    let inv = 1.0 / sqrtf(if ss > 1e-24 { ss } else { 1e-24 });
    for (j, v) in pooled[..d].iter().enumerate() {
        *out.add(j) = v * inv;
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn out_dim() -> usize {
    match (*core::ptr::addr_of!(CFG)).as_ref() {
        Some(c) => c.out_dim,
        None => 0,
    }
}

#[no_mangle]
pub unsafe extern "C" fn max_tokens() -> usize {
    match (*core::ptr::addr_of!(CFG)).as_ref() {
        Some(c) => c.max_t,
        None => 0,
    }
}

/// Test hook: round-half-even as used for the activation quantisation
#[no_mangle]
pub extern "C" fn round_even(x: f32) -> f32 {
    nearest(x)
}

/// Score `n` int8-quantised vectors of `dim` dims (dim multiple of 16,
/// contiguous) against an int16-quantised query:
/// score[i] = (v_i · q) * scales[i] * q_scale
#[no_mangle]
pub unsafe extern "C" fn scan_i8(
    vecs: *const i8,
    scales: *const f32,
    n: usize,
    dim: usize,
    q: *const i16,
    q_scale: f32,
    out: *mut f32,
) {
    for i in 0..n {
        let base = vecs.add(i * dim);
        let mut acc = i32x4_splat(0);
        let mut c = 0;
        while c < dim {
            let v = v128_load(base.add(c) as *const v128);
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_low_i8x16(v), v128_load(q.add(c) as *const v128)));
            acc = i32x4_add(acc, i32x4_dot_i16x8(i16x8_extend_high_i8x16(v), v128_load(q.add(c + 8) as *const v128)));
            c += 16;
        }
        *out.add(i) = (hsum_i32(acc) as f32) * *scales.add(i) * q_scale;
    }
}
