semsearch-window-title = Ricerca semantica
semsearch-menu-open = Ricerca semantica…
semsearch-menu-item = Ricerca semantica
semsearch-menu-find-similar = Trova documenti simili
semsearch-menu-search-abstract = Cerca passaggi simili all’abstract
semsearch-menu-index = Indicizza ora
semsearch-menu-reindex = Reindicizza (passaggi a testo completo)
semsearch-menu-exclude = Escludi dalla ricerca semantica
semsearch-menu-include = Includi nella ricerca semantica

semsearch-menuitem-open =
    .label = Ricerca semantica…
semsearch-menuitem-item =
    .label = Ricerca semantica
semsearch-menuitem-find-similar =
    .label = Trova documenti simili
semsearch-menuitem-search-abstract =
    .label = Cerca passaggi simili all’abstract
semsearch-menuitem-index =
    .label = Indicizza ora
semsearch-menuitem-reindex =
    .label = Reindicizza (passaggi a testo completo)
semsearch-menuitem-exclude =
    .label = Escludi dalla ricerca semantica
semsearch-menuitem-include =
    .label = Includi nella ricerca semantica

semsearch-pane-header =
    .label = Ricerca semantica
semsearch-pane-sidenav =
    .tooltiptext = Ricerca semantica
semsearch-pane-indexed = Indicizzato: { $count } passaggi ({ $date })
semsearch-pane-indexed-legacy = Indicizzato in sezioni lunghe: { $count } sezioni ({ $date })
semsearch-pane-not-indexed = Non ancora indicizzato
semsearch-pane-excluded = Escluso ({ $reason })
semsearch-pane-no-pdf = Nessun allegato PDF
semsearch-pane-indexing = Indicizzazione… { $done }/{ $total }
semsearch-pane-queued = In coda per l’indicizzazione
semsearch-pane-similar = Documenti simili
semsearch-pane-similar-none = Nessun documento simile trovato

semsearch-prefs-title = Ricerca semantica
semsearch-prefs-search = Ricerca
semsearch-prefs-min-similarity = Similarità minima:
semsearch-prefs-max-results = Numero massimo di risultati:
semsearch-prefs-indexing = Indicizzazione
semsearch-prefs-auto-index = Indicizza automaticamente i nuovi PDF
semsearch-prefs-workers = Processi di indicizzazione in parallelo:
semsearch-prefs-model = Modello di embedding
semsearch-prefs-model-desc = Il modello che trasforma passaggi e ricerche in vettori. Funziona localmente in Zotero. Ogni modello ha il suo indice: cambiare modello reindicizza tutti i PDF, in background.
semsearch-model-option-lealla = LEALLA-large (109 lingue, per traduzioni)
semsearch-model-option-e5-small = Multilingual E5 small (consigliato)
semsearch-model-option-arctic-m-v2 = Arctic Embed M v2 (massima accuratezza)
semsearch-model-info-lealla = Il modello con più lingue: 109. Progettato per riconoscere frasi con lo stesso significato in lingue diverse (come un testo e la sua traduzione), può essere utile per biblioteche in molte lingue. Il meno accurato dei tre nel trovare idee affini. Download: { $size } MB.
semsearch-model-info-e5-small = Circa 100 lingue. Molto più accurato di LEALLA-large e un po’ più veloce da indicizzare. Download: { $size } MB.
semsearch-model-info-arctic-m-v2 = 74 lingue (tutte le principali lingue europee e asiatiche). Il più accurato, soprattutto quando ricerca e passaggi sono in lingue diverse, ma l’indicizzazione richiede circa 3 volte il tempo di E5. Download: { $size } MB.
semsearch-model-switch-title = Passare a { $model }?
semsearch-model-switch-new = { $model } verrà scaricato ({ $size } MB) e tutti i tuoi PDF verranno indicizzati con questo modello, in background. Con una libreria grande possono servire molte ore. Fino ad allora le ricerche continuano a usare { $current }.
semsearch-model-switch-keep = L’indice di { $current } viene conservato: puoi tornare indietro in qualsiasi momento.
semsearch-model-switch-existing = Esiste già un indice di { $model }: verranno indicizzati solo i PDF aggiunti dall’ultima volta che è stato usato, poi { $model } diventerà il modello attivo.
semsearch-model-active = In uso: { $model }
semsearch-build-downloading = Download di { $model }… { $percent }%
semsearch-build-waiting = Preparazione dell’indice di { $model }…
semsearch-build-status = Costruzione dell’indice di { $model }: { $done } di { $total } documenti. Fino al termine le ricerche usano { $current }.
semsearch-build-use-now = Usa subito
    .title = Passa subito al nuovo modello, cercando solo nei documenti già indicizzati
semsearch-build-resume = Continua
semsearch-build-cancel = Annulla il cambio
semsearch-indexes = Indici su disco:
semsearch-index-row = { $model }: { $size }
semsearch-index-in-use = in uso
semsearch-index-delete = Elimina
semsearch-index-delete-confirm = Eliminare l’indice di { $model } ({ $size })? Per tornare a { $model } bisognerà indicizzare di nuovo tutti i PDF.
semsearch-prefs-database = Database
semsearch-prefs-mcp = Server MCP per assistenti AI
semsearch-prefs-mcp-enable = Attiva l’endpoint MCP locale
semsearch-prefs-mcp-desc = Permette agli assistenti AI su questo computer (Claude Code, Claude Desktop, …) di cercare nella tua biblioteca. Possono collegarsi solo i programmi locali.
semsearch-prefs-mcp-claude-code = Claude Code:
semsearch-prefs-mcp-desktop = Claude Desktop: installa l’estensione (.mcpb) dalla pagina delle release. Configurazione manuale (claude_desktop_config.json, tramite mcp-remote):
semsearch-prefs-copy = Copia
semsearch-prefs-maintenance = Manutenzione
semsearch-prefs-rebuild-cache = Ricostruisci la cache dei vettori

semsearch-model-missing = Prima di cercare occorre scaricare una volta il modello di embedding ({ $model }, { $size } MB).
semsearch-model-download = Scarica il modello
semsearch-model-downloading = Download del modello… { $percent }%
semsearch-model-verifying = Verifica del download…
semsearch-model-ready = Modello pronto
semsearch-model-error = Download non riuscito: { $error }

semsearch-query-placeholder =
    .placeholder = Scrivi un concetto, una frase o un paragrafo del tuo testo…
semsearch-search = Cerca
semsearch-rerun = Ripeti la ricerca
semsearch-threshold = Similarità min.
semsearch-group = Raggruppa per documento
semsearch-filter-all = Tutti i risultati
semsearch-filter-hide-irrelevant = Nascondi irrilevanti
semsearch-filter-todo = Da vedere
semsearch-filter-cited = Citati
semsearch-filter-irrelevant = Irrilevanti
semsearch-history = Ricerche salvate
semsearch-history-filter =
    .placeholder = Filtra le ricerche
semsearch-history-empty = Nessuna ricerca salvata
semsearch-history-delete =
    .title = Elimina questa ricerca
semsearch-excluded = Documenti esclusi ({ $count })
semsearch-excluded-title = Documenti esclusi
semsearch-excluded-empty = Nessun documento escluso
semsearch-excluded-include = Includi di nuovo
semsearch-reason-encrypted = cifrato
semsearch-reason-no_text = senza testo
semsearch-reason-manual = escluso manualmente
semsearch-reason-duplicate = duplicato
semsearch-reason-unreadable = illeggibile
semsearch-reason-other = altro

semsearch-results-count = { $count ->
    [one] 1 passaggio
   *[other] { $count } passaggi
}
semsearch-results-docs = { $count ->
    [one] in 1 documento
   *[other] in { $count } documenti
}
semsearch-results-from-history = salvata il { $date }
semsearch-results-none = Nessun passaggio ha raggiunto la similarità minima. Prova una ricerca più lunga (una frase o un paragrafo intero) o abbassa la soglia.
semsearch-searching = Ricerca in corso…
semsearch-save-collection = Salva come collezione
semsearch-copy-list = Copia elenco
semsearch-collection-name = Ricerca semantica: { $query }
semsearch-collection-created = Collezione «{ $name }» creata con { $count } elementi.

semsearch-show-in-library = Mostra nella biblioteca
semsearch-open-pdf = Apri PDF
semsearch-open-pdf-page = Apri PDF (p. { $page })
semsearch-copy-prompt = Copia prompt
semsearch-copy-citation = Copia citazione
semsearch-exclude-doc = Escludi documento
semsearch-status-todo = Da vedere
semsearch-status-cited = Citato
semsearch-status-irrelevant = Irrilevante
semsearch-approximate = Posizione stimata (documento indicizzato in sezioni lunghe)
semsearch-locate = Trova il passaggio esatto
semsearch-locating = Ricerca del passaggio…
semsearch-page = p. { $page }
semsearch-also-in = PDF identico anche in altri { $count } elementi
semsearch-matched = corrisponde a: «{ $text }»
semsearch-copied = Copiato
semsearch-missing-item = Elemento non più presente nella biblioteca

semsearch-index-status = { $docs } documenti · { $passages } passaggi
semsearch-index-loading = Caricamento dell’indice…
semsearch-index-building = Preparazione dell’indice (solo la prima volta)… { $done }/{ $total }
semsearch-index-db = Ottimizzazione del database (solo la prima volta)…
semsearch-index-new = Indicizza i nuovi PDF
semsearch-index-pause = Pausa
semsearch-index-resume = Riprendi
semsearch-index-cancel = Interrompi
semsearch-index-running = Indicizzazione { $done }/{ $total }
semsearch-index-current = { $title } ({ $done }/{ $total })
semsearch-index-uptodate = Tutti i PDF sono indicizzati
semsearch-index-found = { $count } nuovi PDF da indicizzare

semsearch-similar-title = Documenti simili a «{ $title }»
semsearch-error = Errore: { $message }

semsearch-type-filter-all = Tipo: tutti
semsearch-type-filter-some = Tipo: { $types }
semsearch-type-filter-reset = Mostra tutti i tipi
semsearch-ocr = Esegui OCR
semsearch-ocr-running = OCR in corso nel terminale…
semsearch-prefs-ocr-languages = Lingue OCR (codici tesseract, es. ita+eng):

semsearch-date-filter-any = Aggiunti: sempre
semsearch-date-filter-since = Aggiunti dal { $date }
semsearch-date-filter-label = Solo elementi aggiunti a Zotero a partire dal:
semsearch-date-filter-1m = Ultimo mese
semsearch-date-filter-6m = Ultimi 6 mesi
semsearch-date-filter-1y = Ultimo anno
semsearch-date-filter-reset = Qualsiasi data

semsearch-history-model =
    .title = Risultati di { $model }
semsearch-results-other-model = trovati con { $model }
semsearch-rerun-with = Ripeti la ricerca con { $model }
semsearch-model-indicator = Modello: { $model }
    .title = Modello di embedding usato per la ricerca. Fai clic per cambiarlo nelle impostazioni.
semsearch-model-indicator-switching = Modello: { $model } → { $next }
    .title = Passaggio a { $next } in corso: le ricerche usano { $model } finché il nuovo indice non è pronto. Fai clic per aprire le impostazioni.
semsearch-new-search = Nuova ricerca
semsearch-toolbar-button =
    .tooltiptext = Ricerca semantica ({ $shortcut })
    .label = Ricerca semantica
semsearch-prefs-mcp-writes = Consenti agli assistenti AI di aggiungere metadati alla libreria (creare elementi genitore per i PDF che non ne hanno)
semsearch-duplicates = { $count ->
    [one] { $count } PDF duplicato
   *[other] { $count } PDF duplicati
}
semsearch-dup-title = PDF duplicati
semsearch-dup-desc = Questi file sono identici, byte per byte. Uniscili in un solo elemento (metadati, note, tag, collezioni e annotazioni vengono riuniti; sui campi in conflitto vince l’elemento modificato più di recente), oppure spunta le copie da spostare nel cestino.
semsearch-dup-scanning = Ricerca di file identici nella libreria… { $done } di { $total }
semsearch-dup-empty = Nessun PDF duplicato.
semsearch-dup-copies = { $count } copie identiche
semsearch-dup-has-metadata = con metadati ({ $count } campi)
semsearch-dup-no-metadata = elemento genitore senza metadati
semsearch-dup-no-parent = nessun elemento genitore
semsearch-dup-notes = { $count ->
    [one] 1 nota
   *[other] { $count } note
}
semsearch-dup-annotations = { $count ->
    [one] 1 annotazione
   *[other] { $count } annotazioni
}
semsearch-dup-collections = { $count ->
    [one] in 1 collezione
   *[other] in { $count } collezioni
}
semsearch-dup-added = aggiunto il { $date }
semsearch-dup-merge = Unisci tutti
semsearch-dup-merge-confirm = Unire questi { $count } elementi in «{ $title }»? Gli altri vengono spostati nel cestino.
semsearch-dup-trash = Sposta nel cestino i selezionati
semsearch-dup-trash-confirm = Spostare nel cestino { $count ->
    [one] la copia selezionata
   *[other] le { $count } copie selezionate
}? Gli elementi genitore che restano senza allegati né note vengono spostati anch’essi.
semsearch-dup-ignore = Tienili tutti (non sono duplicati)
semsearch-dup-new-title = PDF duplicato
semsearch-dup-new-one = Il PDF appena aggiunto, «{ $title }», è identico a { $count ->
    [one] un file già presente nella libreria: «{ $other }».
   *[other] { $count } file già presenti nella libreria, ad es. «{ $other }».
}
semsearch-dup-new-many = { $count } PDF appena aggiunti sono identici a file già presenti nella libreria:
semsearch-dup-new-delete = { $count ->
    [one] Elimina il nuovo file
   *[other] Elimina i nuovi file
}
semsearch-dup-new-keep = { $count ->
    [one] Tienilo comunque
   *[other] Tienili comunque
}
semsearch-dup-new-review = Rivedi…
