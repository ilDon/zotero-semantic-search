import os
import glob
import PyPDF2
import docx2txt
import numpy as np
import tensorflow as tf
from typing import List
from sklearn.metrics.pairwise import cosine_similarity

from src.database import DatabaseHelper

# Load Universal Sentence Encoder
try:
    model_path = "USE_model"
    if not os.path.exists(model_path):
        raise Exception("Model folder not found.")
    embed = tf.saved_model.load(model_path)
except Exception as e:
    print(f"Error: {e}")
    exit()

# Connect to SQLite database
DatabaseHelper.init()
DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS embeddings (
                  id TEXT, file_name TEXT, section_number INTEGER, 
                  embedding BLOB, text_preview TEXT)""")

def process_files():
  # Traverse through the files
  for folder in glob.glob("main_folder/*"):
      folder_id = os.path.basename(folder)
      for file in glob.glob(f"{folder}/*"):
          file_name = os.path.basename(file)
          file_text = ""
          if file.endswith(".pdf"):
              with open(file, "rb") as pdf_file:
                  reader = PyPDF2.PdfFileReader(pdf_file)
                  for page in range(reader.numPages):
                      file_text += reader.getPage(page).extractText()
          # elif file.endswith(".docx"):
            #  file_text = docx2txt.process(file)

          # Split and truncate the contents
          max_length = 128  # Optimal length for Universal Sentence Encoder
          sections = [file_text[i:i + max_length] for i in range(0, len(file_text), max_length)]

          # Generate and save the embeddings
          for idx, section in enumerate(sections):
              embedding = embed([section]).numpy().tobytes()
              DatabaseHelper.write("INSERT INTO embeddings VALUES (?, ?, ?, ?, ?)",
                            (folder_id, file_name, idx, embedding, section[:50]))

  # Query and search
  query = input("Enter your query: ")
  query_embedding = embed([query]).numpy()

  rows = DatabaseHelper.read("SELECT id, file_name, section_number, embedding, text_preview FROM embeddings")

  results = []
  for row in rows:
      folder_id, file_name, section_number, embedding, text_preview = row
      embedding = np.frombuffer(embedding, dtype=np.float32).reshape(1, -1)
      similarity = cosine_similarity(query_embedding, embedding)[0][0]
      results.append((similarity, folder_id, file_name, section_number, text_preview))

  # Sort and display top 100 results
  top_results = sorted(results, key=lambda x: x[0], reverse=True)[:100]
  for result in top_results:
      print(f"Folder ID: {result[1]}, File: {result[2]}, Section: {result[3]}, "
            f"Similarity: {result[0]:.4f}, Preview: {result[4]}...")

  DatabaseHelper.close()