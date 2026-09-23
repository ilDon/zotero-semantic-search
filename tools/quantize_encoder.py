"""Build the int8 weight files of the XLM-R based encoders used by the plugin,
the shared tokenizer file, and the test oracles.

    python tools/quantize_encoder.py e5-small     --out .models
    python tools/quantize_encoder.py arctic-m-v2  --out .models
    python tools/quantize_encoder.py tokenizer    --out .models

Needs torch, transformers, safetensors and tokenizers.

Weight file (.ssew): "SSEW" | u32 version | u32 header length | JSON header |
zero padding to 64 bytes | tensor data (each tensor 64-byte aligned).
The header lists the model config and, per tensor, dtype (i8/f32), shape and
the byte offset relative to the start of the data section.

Linear layers and the word-embedding table are stored as int8 with one f32
scale per output row (symmetric, scale = max|w| / 127). The plugin runs the
linear layers with int8 activations quantised per token (see
wasm-encoder/src/lib.rs); `--oracle` computes the same thing in PyTorch.
"""
import argparse
import hashlib
import json
import os
import struct
import sys

import numpy as np

MODELS = {
    'e5-small': {
        'repo': 'intfloat/multilingual-e5-small',
        'revision': '614241f622f53c4eeff9890bdc4f31cfecc418b3',
        'arch': 'bert',
        'pooling': 'mean',
        'out_dim': 384,
        'query_prefix': 'query: ',
        'passage_prefix': 'passage: ',
    },
    'arctic-m-v2': {
        'repo': 'Snowflake/snowflake-arctic-embed-m-v2.0',
        'revision': '95c2741480856aa9666782eb4afe11959938017f',
        'arch': 'gte',
        'pooling': 'cls',
        'out_dim': 256,  # Matryoshka truncation
        'query_prefix': 'query: ',
        'passage_prefix': '',
    },
}
MAX_TOKENS = 512
FLAG_GATED, FLAG_ROPE, FLAG_ABS_POS = 1, 2, 4


def q_rows(w):
    """int8 per-row symmetric quantisation -> (int8 array, f32 scales)"""
    w = np.asarray(w, dtype=np.float32)
    scale = (np.abs(w).max(axis=1) / 127).astype(np.float32)
    scale[scale == 0] = np.float32(1e-12)
    q = np.clip(np.round(w / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale


def load_tensors(repo, revision):
    from huggingface_hub import snapshot_download
    from safetensors.numpy import load_file
    path = snapshot_download(repo, revision=revision, allow_patterns=['*.json', '*.safetensors', '*.py', '*.model'])
    return path, load_file(os.path.join(path, 'model.safetensors'))


def build_tensors(name, t, cfg):
    spec = MODELS[name]
    out = {}
    h = cfg['hidden_size']
    word = t['embeddings.word_embeddings.weight']
    out['word.q'], out['word.s'] = q_rows(word)
    out['tt0'] = t['embeddings.token_type_embeddings.weight'][0]
    if spec['arch'] == 'bert':
        out['pos'] = t['embeddings.position_embeddings.weight'][:MAX_TOKENS]
    out['emb_ln.g'] = t['embeddings.LayerNorm.weight']
    out['emb_ln.b'] = t['embeddings.LayerNorm.bias']
    for i in range(cfg['num_hidden_layers']):
        p = f'encoder.layer.{i}.'
        L = f'l{i}.'
        if spec['arch'] == 'bert':
            a = p + 'attention.self.'
            qkv_w = np.concatenate([t[a + 'query.weight'], t[a + 'key.weight'], t[a + 'value.weight']])
            qkv_b = np.concatenate([t[a + 'query.bias'], t[a + 'key.bias'], t[a + 'value.bias']])
            o_w, o_b = t[p + 'attention.output.dense.weight'], t[p + 'attention.output.dense.bias']
            ln1 = (t[p + 'attention.output.LayerNorm.weight'], t[p + 'attention.output.LayerNorm.bias'])
            up_w, up_b = t[p + 'intermediate.dense.weight'], t[p + 'intermediate.dense.bias']
            down_w, down_b = t[p + 'output.dense.weight'], t[p + 'output.dense.bias']
            ln2 = (t[p + 'output.LayerNorm.weight'], t[p + 'output.LayerNorm.bias'])
        else:
            qkv_w, qkv_b = t[p + 'attention.qkv_proj.weight'], t[p + 'attention.qkv_proj.bias']
            o_w, o_b = t[p + 'attention.o_proj.weight'], t[p + 'attention.o_proj.bias']
            ln1 = (t[p + 'attn_ln.weight'], t[p + 'attn_ln.bias'])
            up_w, up_b = t[p + 'mlp.up_gate_proj.weight'], None  # rows: [up; gate]
            down_w, down_b = t[p + 'mlp.down_proj.weight'], t[p + 'mlp.down_proj.bias']
            ln2 = (t[p + 'mlp_ln.weight'], t[p + 'mlp_ln.bias'])
        out[L + 'qkv.q'], out[L + 'qkv.s'] = q_rows(qkv_w)
        out[L + 'qkv.b'] = qkv_b
        out[L + 'o.q'], out[L + 'o.s'] = q_rows(o_w)
        out[L + 'o.b'] = o_b
        out[L + 'ln1.g'], out[L + 'ln1.b'] = ln1
        out[L + 'up.q'], out[L + 'up.s'] = q_rows(up_w)
        if up_b is not None:
            out[L + 'up.b'] = up_b
        out[L + 'down.q'], out[L + 'down.s'] = q_rows(down_w)
        out[L + 'down.b'] = down_b
        out[L + 'ln2.g'], out[L + 'ln2.b'] = ln2
    assert h % 16 == 0
    return out


def write_ssew(path, header, tensors):
    data = bytearray()
    index = {}
    for k, v in tensors.items():
        v = np.ascontiguousarray(v)
        if v.dtype == np.int8:
            dt = 'i8'
        else:
            v = v.astype(np.float32)
            dt = 'f32'
        pad = (-len(data)) % 64
        data += b'\0' * pad
        index[k] = {'dtype': dt, 'shape': list(v.shape), 'offset': len(data), 'length': v.nbytes}
        data += v.tobytes()
    header = dict(header, tensors=index)
    hb = json.dumps(header, separators=(',', ':')).encode()
    pre = b'SSEW' + struct.pack('<II', 1, len(hb)) + hb
    pre += b'\0' * ((-len(pre)) % 64)
    with open(path, 'wb') as f:
        f.write(pre)
        f.write(data)


def file_info(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return {'name': os.path.basename(path), 'size': os.path.getsize(path), 'sha256': h.hexdigest()}


def export_tokenizer(out_dir):
    """Pieces, scores and the precompiled normalisation map of the XLM-R
    SentencePiece model (identical in multilingual-e5 and Arctic-embed v2)."""
    from huggingface_hub import hf_hub_download
    spec = MODELS['e5-small']
    tj = json.load(open(hf_hub_download(spec['repo'], 'tokenizer.json', revision=spec['revision'])))
    model = tj['model']
    assert model['type'] == 'Unigram'
    norm = tj['normalizer']['normalizers'][0]
    assert norm['type'] == 'Precompiled'
    out = {
        'type': 'xlmr-unigram',
        'unk_id': model['unk_id'],
        'bos_id': 0,
        'eos_id': 2,
        'pieces': [p for p, _ in model['vocab']],
        'scores': [s for _, s in model['vocab']],
        'charsmap': norm['precompiled_charsmap'],
    }
    path = os.path.join(out_dir, 'xlmr-tokenizer.json')
    with open(path, 'w') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    return path


# ---------------------------------------------------------------- reference

def load_hf(name):
    import torch
    from transformers import AutoModel, AutoTokenizer
    spec = MODELS[name]
    kw = {}
    if spec['arch'] == 'gte':
        kw = dict(trust_remote_code=True, use_memory_efficient_attention=False, unpad_inputs=False)
    tok = AutoTokenizer.from_pretrained(spec['repo'], revision=spec['revision'], **({'trust_remote_code': True} if kw else {}))
    model = AutoModel.from_pretrained(spec['repo'], revision=spec['revision'], dtype=torch.float32, **kw).eval()
    return tok, model


def fake_quantize(name, model, tensors):
    """Make `model` compute exactly what the int8 WASM encoder computes."""
    import torch
    import torch.nn as nn
    spec = MODELS[name]
    deq = lambda k: torch.from_numpy(tensors[k + '.q'].astype(np.float32) * tensors[k + '.s'][:, None])
    with torch.no_grad():
        model.embeddings.word_embeddings.weight.copy_(deq('word'))
        for i, layer in enumerate(model.encoder.layer):
            L = f'l{i}.'
            if spec['arch'] == 'bert':
                h = model.config.hidden_size
                qkv = deq(L + 'qkv')
                layer.attention.self.query.weight.copy_(qkv[:h])
                layer.attention.self.key.weight.copy_(qkv[h:2 * h])
                layer.attention.self.value.weight.copy_(qkv[2 * h:])
                layer.attention.output.dense.weight.copy_(deq(L + 'o'))
                layer.intermediate.dense.weight.copy_(deq(L + 'up'))
                layer.output.dense.weight.copy_(deq(L + 'down'))
            else:
                layer.attention.qkv_proj.weight.copy_(deq(L + 'qkv'))
                layer.attention.o_proj.weight.copy_(deq(L + 'o'))
                layer.mlp.up_gate_proj.weight.copy_(deq(L + 'up'))
                layer.mlp.down_proj.weight.copy_(deq(L + 'down'))

    def hook(mod, args):
        x = args[0]
        s = (x.abs().amax(dim=-1, keepdim=True) / 127).clamp(min=1e-12 / 127)
        return ((x / s).round().clamp(-127, 127) * s,)

    for mod in model.encoder.modules():
        if isinstance(mod, nn.Linear):
            mod.register_forward_pre_hook(hook)


def embed(name, tok, model, texts):
    import torch
    import torch.nn.functional as F
    spec = MODELS[name]
    out, ids_out = [], []
    with torch.no_grad():
        for t in texts:
            b = tok(t, truncation=True, max_length=MAX_TOKENS, return_tensors='pt')
            ids_out.append(b['input_ids'][0].tolist())
            h = model(input_ids=b['input_ids'], attention_mask=b['attention_mask']).last_hidden_state[0]
            e = h.mean(0) if spec['pooling'] == 'mean' else h[0]
            out.append(F.normalize(e[:spec['out_dim']], dim=-1).numpy())
    return ids_out, np.stack(out)


def oracle_texts():
    """A few passages and queries in several languages (fixed, public-domain style text)."""
    return [
        ('query', 'What are the limits of deep learning models?'),
        ('query', 'Quali sono i limiti della responsabilità della pubblica amministrazione per i danni causati da algoritmi?'),
        ('query', 'transparencia de los algoritmos en las decisiones administrativas'),
        ('query', 'Datenschutz und automatisierte Entscheidungen'),
        ('query', '机器学习模型的可解释性'),
        ('passage', 'Deep learning models are often described as black boxes: their internal representations are '
                    'distributed across millions of parameters and cannot be inspected directly by a human.'),
        ('passage', 'La pubblica amministrazione può adottare decisioni automatizzate soltanto se l\'algoritmo è '
                    'conoscibile e comprensibile, e se il risultato è imputabile a un organo titolare del potere.'),
        ('passage', 'Le principe de transparence impose que l\'administré puisse connaître les règles de '
                    'traitement algorithmique et les principales caractéristiques de leur mise en œuvre.'),
        ('passage', 'Die Verarbeitung personenbezogener Daten ist nur rechtmäßig, wenn mindestens eine der '
                    'nachstehenden Bedingungen erfüllt ist.'),
        ('passage', 'Архитектура трансформера основана на механизме внимания, без рекуррентных слоёв.'),
        ('passage', 'نموذج اللغة الكبير يتنبأ بالكلمة التالية بناءً على السياق'),
        ('passage', 'ディープラーニングは多層のニューラルネットワークを用いた機械学習の手法である。'),
        ('passage', 'Short.'),
        ('passage', 'ﬁnancial “quotes” — and ½ fractions, ＦＵＬＬＷＩＤＴＨ text, café vs café, emoji 🚀🎉.'),
        ('passage', ' '.join(['The attention mechanism relates every token to every other token.'] * 50)),
    ]


def make_oracle(name, tensors, out_path):
    spec = MODELS[name]
    tok, model = load_hf(name)
    items = oracle_texts()
    texts = [(spec['query_prefix'] if kind == 'query' else spec['passage_prefix']) + t for kind, t in items]
    ids, fp32 = embed(name, tok, model, texts)
    fake_quantize(name, model, tensors)
    _, q = embed(name, tok, model, texts)
    cos = (fp32 * q).sum(1)
    print(f'{name}: fake-quant vs fp32 cosine min {cos.min():.5f} mean {cos.mean():.5f}')
    json.dump({
        'model': name,
        'texts': texts,
        'ids': ids,
        'fp32': [[round(float(x), 6) for x in v] for v in fp32],
        'int8': [[round(float(x), 6) for x in v] for v in q],
    }, open(out_path, 'w'), ensure_ascii=False)


def tokenizer_oracle(out_path):
    """Token ids from the HF tokenizer on many texts, for the JS tokenizer test."""
    from transformers import AutoTokenizer
    spec = MODELS['e5-small']
    tok = AutoTokenizer.from_pretrained(spec['repo'], revision=spec['revision'])
    texts = [t for _, t in oracle_texts()]
    bench = os.environ.get('BENCH_SET')
    if bench and os.path.exists(bench):
        docs = json.load(open(bench))
        for d in docs[::6]:
            texts.append(d['abstract'][:1500])
            texts.extend(c[:800] for c in d['chunks'][:3])
    texts += [
        'naïve résumé coöperate', 'Ǆemal ǅ ǆ', 'x² + y³ = z⁴', 'Ⅻ ⅻ ㎏ ㍿', '٣٤٥ ۴۵۶', '한국어 문장입니다.',
        'ไทย ภาษา', 'हिन्दी भाषा', 'é à ö', ' non-breaking spaces', 'tab\tand\nnewline',
        'ＡＢＣ１２３', '“smart” ‘quotes’ «guillemets»', 'a---b...c', '👩‍👩‍👧 family',
    ]
    ids = [tok(' '.join(t.split()), truncation=True, max_length=MAX_TOKENS)['input_ids'] for t in texts]
    json.dump({'texts': [' '.join(t.split()) for t in texts], 'ids': ids}, open(out_path, 'w'), ensure_ascii=False)
    print('tokenizer oracle:', len(texts), 'texts')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('what', choices=list(MODELS) + ['tokenizer'])
    ap.add_argument('--out', default='.models')
    ap.add_argument('--oracle', help='write a test oracle JSON here')
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    if args.what == 'tokenizer':
        path = export_tokenizer(args.out)
        print(json.dumps(file_info(path)))
        if args.oracle:
            tokenizer_oracle(args.oracle)
        return
    spec = MODELS[args.what]
    path, t = load_tensors(spec['repo'], spec['revision'])
    cfg = json.load(open(os.path.join(path, 'config.json')))
    tensors = build_tensors(args.what, t, cfg)
    gte = spec['arch'] == 'gte'
    header = {
        'format': 1,
        'model': args.what,
        'source': {'repo': spec['repo'], 'revision': spec['revision']},
        'config': {
            'flags': (FLAG_GATED | FLAG_ROPE) if gte else FLAG_ABS_POS,
            'hidden': cfg['hidden_size'],
            'heads': cfg['num_attention_heads'],
            'ffn': cfg['intermediate_size'],
            'layers': cfg['num_hidden_layers'],
            'max_tokens': MAX_TOKENS,
            'pooling': 1 if spec['pooling'] == 'cls' else 0,
            'out_dim': spec['out_dim'],
            'ln_eps': cfg.get('layer_norm_eps', 1e-12),
            'rope_theta': cfg.get('rope_theta', 0) if gte else 0,
            'vocab': int(t['embeddings.word_embeddings.weight'].shape[0]),
        },
    }
    out = os.path.join(args.out, f'{args.what}-int8.ssew')
    write_ssew(out, header, tensors)
    print(json.dumps(file_info(out)))
    if args.oracle:
        make_oracle(args.what, tensors, args.oracle)


if __name__ == '__main__':
    sys.exit(main())
