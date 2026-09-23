# Zotero Semantic Search

A Zotero 7–10 plugin that searches the **full text of the PDFs in your library by meaning**, not by keywords — and lets AI assistants on your computer do the same through a local **MCP** endpoint.

Write a concept, a sentence or a whole paragraph of your draft; the plugin returns the passages of your PDFs whose meaning is closest, ranked by cosine similarity, linked to their Zotero items and pages.

Everything runs inside Zotero: no Python, no local server to start, no separate web app.

> Version 2 is a complete rewrite of the original Python + React app (kept on the `archive/python-react-app` branch). **Databases built by the original app keep working as they are.**

## Features

- **Semantic search window** (Tools → Semantic Search…, or <kbd>⌘/Ctrl</kbd>+<kbd>⇧</kbd>+<kbd>E</kbd>): results with similarity, passage text, page; open the PDF at the page, show the item in the library, copy a citation, or copy the "how does this excerpt support my text" prompt of the original app.
- **Filter results by item type** (book, journal article, …; multiple selection): works on the results already found, including saved searches.
- **OCR for PDFs without text**: documents excluded as *no text* get a *Run OCR* button (in the excluded list and in the item pane). It opens your default terminal and runs [ocrmypdf](https://ocrmypdf.readthedocs.io) (must be installed, e.g. `brew install ocrmypdf`) with `--force-ocr` and the languages set in the preferences (default `ita+eng`); when it finishes, the original PDF is replaced in place (same folder and name) and the document is re-indexed automatically, even if Zotero was restarted in the meantime. (`--force-ocr` rather than `--skip-text`, which ocrmypdf does not allow together: *skip-text* would skip every page carrying even a watermark.)
- **Saved searches**: every search is stored in the history (as before) and repeated searches are answered instantly from it. Mark results as *To review / Cited / Irrelevant*; the marks are saved.
- **Incremental indexing**: new PDFs are detected and indexed automatically in the background; only what is not yet indexed (or excluded) is processed.
- **Zotero integration**: an item-pane section with the index status of each PDF and its most similar documents; context-menu actions (find similar documents, index/re-index, exclude/include); save results as a collection.
- **MCP server** for AI assistants (Claude Code, Claude Desktop, …): `semantic_search`, `get_passage`, `get_item`, `find_similar_items`, `index_status`, `list_saved_searches`.
- Italian and English interface.

## Installation

1. Build the plugin (or use a released `.xpi`):
   ```bash
   node scripts/build.mjs
   ```
   This creates `build/zotero-semantic-search-<version>.xpi`.
2. In Zotero: Tools → Plugins → gear icon → *Install Plugin From File…* → choose the `.xpi`.
3. Open Tools → Semantic Search… The first time, the plugin downloads the embedding model (590 MB, from Hugging Face, checksum-verified) into your Zotero profile.

The plugin uses `file_embeddings.db` in your Zotero data directory (next to `zotero.sqlite`) — exactly where the original app kept it. If it does not exist it is created; the path can be changed in the preferences.

## Compatibility with the original database

The original app embedded every PDF with Google's **LEALLA-large** (TF Hub). Because query and document vectors must come from the same model, the plugin runs a re-implementation of that exact model, verified against the original TensorFlow graph:

- identical token ids on 1,018 real passages from the library, cosine similarity **1.0000000** between the plugin's embeddings and TensorFlow's;
- replaying the 55 searches saved by the original app returns the same results, with similarities equal to ~10⁻⁶.

What is kept as is: the `embeddings`, `excluded` and `history` tables and their meaning (attachment key = storage folder name, sha256 query ids, result JSON). What is added (additive, the original app could still read the file): an index on `embeddings(id)`, and the columns `scheme`, `chunk_text`, `page`, `char_start`.

### Old vs new passages

The original app cut each PDF into 2,500-character sections, but the model only reads the first 128 tokens of its input, so most of every section was never embedded. Newly indexed PDFs are cut into passages that fit the model's window (at sentence boundaries), so the **whole text** is searchable, and each passage stores its text and page.

For documents indexed by the original app, the passage text is recovered from the PDF at the section's estimated position (marked "≈"); *Find exact passage* locates it precisely by re-embedding nearby windows. Preferences → *Re-index documents of the previous version* upgrades them to full-text passages (slow; it also changes their passages in saved results).

## MCP (AI assistants)

The endpoint lives on Zotero's local HTTP server and accepts only local, non-browser requests:

```
http://127.0.0.1:23119/semantic-search/mcp
```

Claude Code:

```bash
claude mcp add --transport http zotero http://127.0.0.1:23119/semantic-search/mcp
```

Claude Desktop (`claude_desktop_config.json`, via [mcp-remote](https://www.npmjs.com/package/mcp-remote)):

```json
{
  "mcpServers": {
    "zotero": { "command": "npx", "args": ["-y", "mcp-remote", "http://127.0.0.1:23119/semantic-search/mcp"] }
  }
}
```

Searches made through MCP are not added to your search history. Zotero must be running. The endpoint can be disabled in the preferences.

## How it works

| Piece | Where |
| --- | --- |
| Tokenizer reproducing the TF graph (control-char removal, ICU script tokenization, WordPiece) | `addon/content/lib/tokenizer.js` |
| LEALLA-large forward pass (24 layers, GELU pooler) + int8 vector scan, Rust → WebAssembly SIMD | `wasm/src/lib.rs` → `addon/content/lealla.wasm` |
| Embedding workers (ChromeWorkers), chunking | `addon/content/workers/`, `lib/embedder.js`, `lib/chunker.js` |
| `file_embeddings.db` access | `lib/store.js` |
| In-memory int8 index (≈130 MB for 500k passages, cached in the profile), exact re-ranking | `lib/vector-index.js`, `lib/search.js` |
| Incremental indexing, library watcher | `lib/indexer.js` |
| MCP protocol / Zotero endpoint | `lib/mcp.js`, `lib/mcp-endpoint.js` |
| UI (window, item pane, menus, preferences) | `addon/content/ui/`, `lib/ui.js`, `addon/locale/` |

Weights come from the Hugging Face port [`setu4993/LEALLA-large`](https://huggingface.co/setu4993/LEALLA-large) (pinned revision), whose tensors are bit-identical to the TF Hub model; the port's `BertModel` is *not* equivalent to the original graph (tanh pooler, wrong token-type row), which is why the forward pass is implemented here.

Typical timings (Apple M4 Pro): full scan of 500k passages 16 ms, a whole search with exact re-ranking ~150 ms, one passage embedded in ~30–100 ms, index loaded from cache in <1 s.

## Development

```bash
npm test                      # tokenizer/encoder vs TF oracle fixtures, chunker, MCP, scan kernel
node scripts/build.mjs --wasm # rebuild lealla.wasm (Rust, wasm32-unknown-unknown) and the .xpi
```

Model-dependent tests need `.model/model.safetensors` and `.model/vocab.txt` (or `MODEL_DIR`). `tools/tf_oracle.py` runs the original TF Hub model to produce ground truth; `tools/reference_model.py` is a readable PyTorch version of the graph.

To run the plugin from source, put a file named `semantic-search@ildon.github.io` containing the absolute path of `addon/` in your Zotero profile's `extensions/` folder.
