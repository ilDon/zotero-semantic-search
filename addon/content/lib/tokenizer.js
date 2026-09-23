/*
 * Tokenizer that reproduces, token for token, the preprocessing baked into the
 * TF Hub model google/LEALLA/LEALLA-large/1 (the model that produced the
 * legacy file_embeddings.db):
 *
 *   1. remove every \p{Cc} / \p{Cf} character (note: this includes \n and \t,
 *      so words split across lines are glued together — this is intentional,
 *      it is what the original model did);
 *   2. split on every change of Unicode Script (ICU UnicodeScriptTokenizer:
 *      whitespace counts as Common and is dropped), then split Han tokens,
 *      tokens with emoji and punctuation/symbol-only tokens into characters;
 *   3. greedy longest-match WordPiece with "##" continuation prefix,
 *      max 100 UTF-8 bytes per word, whole word -> [UNK] when not coverable;
 *   4. [CLS] + first (maxLength - 2) pieces + [SEP].
 *
 * Works in Zotero windows, ChromeWorkers and Node (for tests).
 */
(function (root, factory) {
	if (typeof module === 'object' && module.exports) {
		module.exports = factory();
	}
	else {
		root.SSTokenizer = factory();
	}
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const MAX_BYTES_PER_WORD = 100;
	const WHITESPACE_RE = /^\p{White_Space}$/u;

	// Every script name understood by JS Unicode property escapes. Order does not
	// matter: Script (not Script_Extensions) is a partition of the code space.
	const SCRIPT_NAMES = [
		'Common', 'Inherited', 'Latin', 'Greek', 'Cyrillic', 'Armenian', 'Hebrew', 'Arabic',
		'Syriac', 'Thaana', 'Devanagari', 'Bengali', 'Gurmukhi', 'Gujarati', 'Oriya', 'Tamil',
		'Telugu', 'Kannada', 'Malayalam', 'Sinhala', 'Thai', 'Lao', 'Tibetan', 'Myanmar',
		'Georgian', 'Hangul', 'Ethiopic', 'Cherokee', 'Canadian_Aboriginal', 'Ogham', 'Runic',
		'Khmer', 'Mongolian', 'Hiragana', 'Katakana', 'Bopomofo', 'Han', 'Yi', 'Old_Italic',
		'Gothic', 'Deseret', 'Tagalog', 'Hanunoo', 'Buhid', 'Tagbanwa', 'Limbu', 'Tai_Le',
		'Linear_B', 'Ugaritic', 'Shavian', 'Osmanya', 'Cypriot', 'Braille', 'Buginese', 'Coptic',
		'New_Tai_Lue', 'Glagolitic', 'Tifinagh', 'Syloti_Nagri', 'Old_Persian', 'Kharoshthi',
		'Balinese', 'Cuneiform', 'Phoenician', 'Phags_Pa', 'Nko', 'Sundanese', 'Lepcha',
		'Ol_Chiki', 'Vai', 'Saurashtra', 'Kayah_Li', 'Rejang', 'Lycian', 'Carian', 'Lydian',
		'Cham', 'Tai_Tham', 'Tai_Viet', 'Avestan', 'Egyptian_Hieroglyphs', 'Samaritan', 'Lisu',
		'Bamum', 'Javanese', 'Meetei_Mayek', 'Imperial_Aramaic', 'Old_South_Arabian',
		'Inscriptional_Parthian', 'Inscriptional_Pahlavi', 'Old_Turkic', 'Kaithi', 'Batak',
		'Brahmi', 'Mandaic', 'Chakma', 'Meroitic_Cursive', 'Meroitic_Hieroglyphs', 'Miao',
		'Sharada', 'Sora_Sompeng', 'Takri', 'Caucasian_Albanian', 'Bassa_Vah', 'Duployan',
		'Elbasan', 'Grantha', 'Pahawh_Hmong', 'Khojki', 'Linear_A', 'Mahajani', 'Manichaean',
		'Mende_Kikakui', 'Modi', 'Mro', 'Old_North_Arabian', 'Nabataean', 'Palmyrene',
		'Pau_Cin_Hau', 'Old_Permic', 'Psalter_Pahlavi', 'Siddham', 'Khudawadi', 'Tirhuta',
		'Warang_Citi', 'Ahom', 'Anatolian_Hieroglyphs', 'Hatran', 'Multani', 'Old_Hungarian',
		'SignWriting', 'Adlam', 'Bhaiksuki', 'Marchen', 'Newa', 'Osage', 'Tangut', 'Masaram_Gondi',
		'Nushu', 'Soyombo', 'Zanabazar_Square', 'Dogra', 'Gunjala_Gondi', 'Makasar', 'Medefaidrin',
		'Hanifi_Rohingya', 'Sogdian', 'Old_Sogdian', 'Elymaic', 'Nandinagari', 'Nyiakeng_Puachue_Hmong',
		'Wancho', 'Chorasmian', 'Dives_Akuru', 'Khitan_Small_Script', 'Yezidi', 'Cypro_Minoan',
		'Old_Uyghur', 'Tangsa', 'Toto', 'Vithkuqi', 'Kawi', 'Nag_Mundari',
	];
	const SCRIPT_REGEXES = [];
	for (const name of SCRIPT_NAMES) {
		try {
			SCRIPT_REGEXES.push(new RegExp(`^\\p{Script=${name}}$`, 'u'));
		}
		catch (e) {
			// Script unknown to this JS engine; its characters fall into "Unknown".
		}
	}
	const UNKNOWN_SCRIPT = 255;
	const WHITESPACE = 254;
	const NOT_COMPUTED = 0;
	const COMMON_SCRIPT = 1; // index of 'Common' in SCRIPT_NAMES, 1-based
	// 1-based script ids (0 = not yet computed), cached per code point
	const scriptCache = new Uint8Array(0x110000);

	function charClass(cp) {
		let v = scriptCache[cp];
		if (v !== NOT_COMPUTED) return v;
		const ch = String.fromCodePoint(cp);
		if (WHITESPACE_RE.test(ch)) {
			v = WHITESPACE; // Script=Common, but flagged so it can be dropped
		}
		else {
			v = UNKNOWN_SCRIPT;
			for (let i = 0; i < SCRIPT_REGEXES.length; i++) {
				if (SCRIPT_REGEXES[i].test(ch)) {
					v = i + 1;
					break;
				}
			}
		}
		scriptCache[cp] = v;
		return v;
	}

	const encoder = new TextEncoder();
	function utf8Length(str) {
		let n = 0;
		for (let i = 0; i < str.length; i++) {
			const c = str.charCodeAt(i);
			if (c < 0x80) n += 1;
			else if (c < 0x800) n += 2;
			else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; }
			else n += 3;
		}
		return n;
	}

	// Tokens that the original graph splits into single characters:
	// Han tokens, tokens containing an emoji, tokens made only of P/S characters.
	const HAN_SCRIPT_RE = /^\p{Script=Han}$/u;
	const EMOJI_RE = /[\u203c\u2049\u2139\u2194-\u2199\u21a9\u21aa\u231a\u231b\u2328\u23cf\u23e9-\u23f3\u23f8-\u23fa\u24c2\u25aa\u25ab\u25b6\u25c0\u25fb-\u25fe\u2600-\u26ff\u2702\u2705\u2708-\u270d\u270f\u2712\u2714\u2716\u271d\u2721\u2728\u2733\u2734\u2744\u2747\u274c\u274e\u2753-\u2755\u2757\u2763\u2764\u2795-\u2797\u2934\u2935\u2b05-\u2b07\u2b1b\u2b1c\u2b50\u2b55\u3030\u303d\u3297\u3299\u{1f004}\u{1f0cf}\u{1f170}\u{1f171}\u{1f17e}\u{1f17f}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f1e6}-\u{1f1ff}\u{1f201}\u{1f202}\u{1f21a}\u{1f22f}\u{1f232}-\u{1f23a}\u{1f250}\u{1f251}\u{1f300}-\u{1f6ff}\u{1f900}-\u{1f9ff}\u{1fa70}-\u{1fa74}\u{1fa78}-\u{1fa7a}\u{1fa80}-\u{1fa86}\u{1fa90}-\u{1faa8}\u{1fab0}-\u{1fab6}\u{1fac0}-\u{1fac2}\u{1fad0}-\u{1fad6}]/u;
	const PUNCT_ONLY_RE = /^[\p{P}\p{S}|]+$/u;

	function shouldSplitChars(word) {
		const first = String.fromCodePoint(word.codePointAt(0));
		return HAN_SCRIPT_RE.test(first) || EMOJI_RE.test(word) || PUNCT_ONLY_RE.test(word);
	}

	/**
	 * Split text into "words" the way the TF graph does.
	 *
	 * ICU UnicodeScriptTokenizer semantics: a token is a maximal run of
	 * characters with the same Unicode Script; whitespace characters belong to
	 * the Common script (so they break Latin runs) but are dropped from the
	 * token text (so "n. 286" becomes "n" + ".286").
	 *
	 * Returns [{ word, start, end }] with offsets into the ORIGINAL string.
	 */
	function splitWords(text) {
		const words = [];
		let cur = '';
		let curStart = -1;
		let curEnd = -1;
		let curScript = -1;
		const n = text.length;
		const flush = () => {
			if (cur) {
				if (shouldSplitChars(cur)) {
					// Offsets of single characters are approximate when whitespace was
					// dropped inside the run; they are only used for chunk boundaries.
					let pos = curStart;
					for (const ch of cur) {
						const at = text.indexOf(ch, pos);
						const s = at === -1 ? pos : at;
						words.push({ word: ch, start: s, end: s + ch.length });
						pos = s + ch.length;
					}
				}
				else {
					words.push({ word: cur, start: curStart, end: curEnd });
				}
			}
			cur = '';
			curStart = -1;
			curScript = -1;
		};
		let i = 0;
		while (i < n) {
			const cp = text.codePointAt(i);
			const len = cp > 0xFFFF ? 2 : 1;
			const ch = len === 2 ? text.substr(i, 2) : text[i];
			// Control/format characters are deleted before tokenization
			if (isControlOrFormat(cp, ch)) {
				i += len;
				continue;
			}
			const cls = charClass(cp);
			const script = cls === WHITESPACE ? COMMON_SCRIPT : cls;
			if (curScript !== -1 && script !== curScript) flush();
			curScript = script;
			if (cls !== WHITESPACE) {
				if (!cur) curStart = i;
				cur += ch;
				curEnd = i + len;
			}
			i += len;
		}
		flush();
		return words;
	}

	const ccCache = new Uint8Array(0x110000); // 0 unknown, 1 no, 2 yes
	const CC_ONE = /^[\p{Cc}\p{Cf}]$/u;
	function isControlOrFormat(cp, ch) {
		let v = ccCache[cp];
		if (v === 0) {
			v = CC_ONE.test(ch) ? 2 : 1;
			ccCache[cp] = v;
		}
		return v === 2;
	}

	class WordPieceTokenizer {
		/**
		 * @param {string|string[]} vocab - vocab.txt content or array of tokens (id = index)
		 */
		constructor(vocab) {
			const tokens = typeof vocab === 'string' ? vocab.split('\n') : vocab;
			if (tokens.length && tokens[tokens.length - 1] === '') tokens.pop();
			this.vocab = new Map();
			for (let i = 0; i < tokens.length; i++) {
				const t = tokens[i].replace(/\r$/, '');
				if (!this.vocab.has(t)) this.vocab.set(t, i);
			}
			this.idToToken = tokens;
			this.clsId = this.vocab.get('[CLS]');
			this.sepId = this.vocab.get('[SEP]');
			this.unkId = this.vocab.get('[UNK]');
			if (this.clsId === undefined || this.sepId === undefined || this.unkId === undefined) {
				throw new Error('Vocabulary is missing special tokens');
			}
		}

		/** WordPiece a single word; returns array of ids */
		wordPiece(word) {
			if (utf8Length(word) > MAX_BYTES_PER_WORD) return [this.unkId];
			const direct = this.vocab.get(word);
			if (direct !== undefined) return [direct];
			// Work on code points so we never cut a surrogate pair
			const chars = Array.from(word);
			const ids = [];
			let start = 0;
			while (start < chars.length) {
				let end = chars.length;
				let found = -1;
				while (start < end) {
					let sub = chars.slice(start, end).join('');
					if (start > 0) sub = '##' + sub;
					const id = this.vocab.get(sub);
					if (id !== undefined) {
						found = id;
						break;
					}
					end--;
				}
				if (found === -1) return [this.unkId];
				ids.push(found);
				start = end;
			}
			return ids;
		}

		/**
		 * Tokenize text into word pieces with character offsets into the input.
		 * @returns {{ids: number[], starts: number[], ends: number[]}}
		 */
		tokenizeWithOffsets(text) {
			const ids = [];
			const starts = [];
			const ends = [];
			for (const w of splitWords(text)) {
				const pieces = this.wordPiece(w.word);
				for (const id of pieces) {
					ids.push(id);
					starts.push(w.start);
					ends.push(w.end);
				}
			}
			return { ids, starts, ends };
		}

		/** Model input ids: [CLS] + first (maxLength-2) pieces + [SEP] */
		encode(text, maxLength = 128) {
			const out = [this.clsId];
			const limit = maxLength - 2;
			for (const w of splitWords(text)) {
				for (const id of this.wordPiece(w.word)) {
					if (out.length - 1 >= limit) break;
					out.push(id);
				}
				if (out.length - 1 >= limit) break;
			}
			out.push(this.sepId);
			return out;
		}
	}

	return { WordPieceTokenizer, splitWords, utf8Length, encoder };
}));
