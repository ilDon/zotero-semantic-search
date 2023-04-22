import os
import tensorflow as tf

# Load Universal Sentence Encoder
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