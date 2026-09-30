semsearch-index — fast indexing for Zotero Semantic Search (macOS, Apple silicon)

Indexes the PDFs of your Zotero library with Multilingual E5 small on the Mac's GPU,
many times faster than inside Zotero. Zotero must be closed while it runs.

  1. In Zotero, choose "Multilingual E5 small" in Settings → Semantic Search
     (this downloads the model the indexer uses), then quit Zotero.
  2. Allow the downloaded files to run (they are not signed):
       xattr -dr com.apple.quarantine semsearch-index-*-macos-arm64
  3. Run:
       ./semsearch-index
     or, if your Zotero data folder is not the one set in Zotero:
       ./semsearch-index /path/to/Zotero

It shows how many PDFs are done and how many are left. Press Ctrl+C to stop at any
time: finished PDFs are kept, and running it again continues where it stopped.
Open Zotero when it is done: the new passages are already in its index.

Options: ./semsearch-index --help
