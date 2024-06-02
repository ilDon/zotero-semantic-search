import os
import pathlib
import tensorflow as tf
import tensorflow_text as text
import tensorflow_hub as hub

# Load Universal Sentence Encoder
# downloaded from https://tfhub.dev/google/universal-sentence-encoder/4
""" 
import os
try:
    model_path = "USE_model"
    if not os.path.exists(model_path):
        raise Exception("Model folder not found.")
    embed = tf.saved_model.load(model_path)
except Exception as e:
    print(f"Error: {e}")
    exit()

def getTextEmbedding(listOfTexts: list):
  return embed(listOfTexts)
   """

# Set the TFHUB_CACHE_DIR environment to a local variable to avoid the models being deleted
tf_hub_models_dir = pathlib.Path("encoder")
tf_hub_models_dir.mkdir(parents=True, exist_ok=True)
os.environ['TFHUB_CACHE_DIR'] = str(tf_hub_models_dir)

encoder = hub.KerasLayer("https://tfhub.dev/google/LEALLA/LEALLA-large/1")

def getTextEmbedding(listOfTexts: list):
  result = encoder(tf.constant(listOfTexts))
  return result