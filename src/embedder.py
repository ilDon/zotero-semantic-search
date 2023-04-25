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


encoder = hub.KerasLayer("https://tfhub.dev/google/LEALLA/LEALLA-large/1")

def getTextEmbedding(listOfTexts: list):
  result = encoder(tf.constant(listOfTexts))
  return result