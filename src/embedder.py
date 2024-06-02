import os
import pathlib
import tensorflow as tf
import tensorflow_text as text
import tensorflow_hub as hub

# Set the TFHUB_CACHE_DIR environment to a local variable to avoid the models being deleted
tf_hub_models_dir = pathlib.Path("encoder")
tf_hub_models_dir.mkdir(parents=True, exist_ok=True)
os.environ['TFHUB_CACHE_DIR'] = str(tf_hub_models_dir)

encoder = hub.KerasLayer("https://tfhub.dev/google/LEALLA/LEALLA-large/1")

def get_text_embedding(texts: list):
    result = encoder(tf.constant(texts))
    return result
