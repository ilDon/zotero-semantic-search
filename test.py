""" from transformers import BertTokenizer, TFBertModel
tokenizer = BertTokenizer.from_pretrained('bert-base-multilingual-cased')
model = TFBertModel.from_pretrained("bert-base-multilingual-cased")
text = "Replace me by any text you'd like."
encoded_input = tokenizer(text, return_tensors='tf')
output = model(encoded_input)
print('output:', output[0])
 """
""" 
import tensorflow as tf
import tensorflow_hub as hub
import tensorflow_text as text

# Load BERT model from TF Hub
model_url = "https://tfhub.dev/tensorflow/bert_en_cased_L-12_H-768_A-12/1"
bert_layer = hub.KerasLayer(model_url, trainable=False)

# Check if BERT model is case sensitive
do_lower_case = bert_layer.resolved_object.do_lower_case.numpy()

# Define some inputs and tokenize it
text_inputs = ["hello world"]

# Load vocabulary from BERT TF Hub model
vocab_file = bert_layer.resolved_object.vocab_file.asset_path

tokenizer = text.BertTokenizer(vocab_file, token_out_type=tf.int64, lower_case=do_lower_case)
tokens = tokenizer.tokenize(text_inputs)

# BERT module excepts a 2D tensor (not 3D)
tokens = tokens.to_tensor()[:, :, 0]
tokens = tf.cast(tokens, dtype=tf.int32)

# Set masks and segment ids
input_mask = tf.ones(tokens.shape, dtype=tf.int32)
segment_ids = tf.zeros(tokens.shape, dtype=tf.int32)

# Embed the inputs.
pooled_output, sequence_output = bert_layer([tokens, input_mask, segment_ids])
print('pooled_output', pooled_output)
print('sequence_output', sequence_output)
 """


""" import os
import tensorflow as tf
import tensorflow_text as text
import tensorflow_hub as hub

# Load Universal Sentence Encoder
try:
    model_path = "LEALLA"
    if not os.path.exists(model_path):
        raise Exception("Model folder not found.")
    embed = tf.saved_model.load(model_path)
except Exception as e:
    print(f"Error: {e}")
    exit()

def getTextEmbedding(listOfTexts: list):
  return embed(listOfTexts)

encoder = hub.KerasLayer("https://tfhub.dev/google/LEALLA/LEALLA-large/1")


result = encoder(tf.constant(["hello world"]))
print('result:', result)
 """

from src.library_processor import LibraryProcessor

processor = LibraryProcessor(search_folder="C:/Users/Gherardo/Dropbox/Zotero/storage")
processor.process_files()