import glob
import PyPDF2
import docx2txt
import numpy as np
from typing import List
from sklearn.metrics.pairwise import cosine_similarity
import json

from src.database import DatabaseHelper
from src.embedder import getTextEmbedding

def query_files():
  DatabaseHelper.init()
  # Query and search
  query = input("Enter your query: ")
  query_embedding = getTextEmbedding([query]).numpy()

  rows = DatabaseHelper.read("SELECT id, file_name, section_number, embedding, text_preview FROM embeddings")

  results = []
  total_len = len(rows)
  i = 0
  for row in rows:
      print(f'\r- Processing file: {i + 1}/{total_len}', end='')
      folder_id, file_name, section_number, embedding, text_preview = row
      embedding = np.array([json.loads(embedding)])
      similarity = cosine_similarity(query_embedding, embedding)[0][0]
      results.append((similarity, folder_id, file_name, section_number, text_preview))
      i += 1

  # Sort and display top 10 results
  top_results = sorted(results, key=lambda x: x[0], reverse=True)[:10]
  for result in top_results:
      print(f"Folder ID: {result[1]}, File: {result[2]}, Section: {result[3]}, "
            f"Similarity: {result[0]:.4f}, Preview: {result[4]}...")

  DatabaseHelper.close()
  DatabaseHelper.close()