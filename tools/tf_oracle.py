"""Ground-truth oracle: runs the ORIGINAL TF Hub LEALLA-large/1 model.

Usage:  python tools/tf_oracle.py <tfhub_model_dir> <in.json> <out.json>
in.json: list of strings. out.json: [{"ids": [...], "embedding": [...]}]
Requires tensorflow==2.17, tensorflow-text==2.17, tensorflow-hub.
"""
import json, sys
import tensorflow as tf
import tensorflow_text  # noqa: F401  (registers the custom ops)

model_dir, inp, out = sys.argv[1:4]
m = tf.saved_model.load(model_dir)
ids_fn = m.prune('source_raw:0', 'map/TensorArrayV2Stack/TensorListStack:0')
emb_fn = m.signatures['default']
texts = json.load(open(inp))
res = []
for i in range(0, len(texts), 64):
    batch = tf.constant(texts[i:i + 64])
    ids = ids_fn(batch).numpy()
    embs = emb_fn(batch)['default'].numpy()
    for row, e in zip(ids, embs):
        row = [int(x) for x in row]
        while row and row[-1] == 0:
            row.pop()
        res.append({"ids": row, "embedding": [float(x) for x in e]})
json.dump(res, open(out, 'w'))
