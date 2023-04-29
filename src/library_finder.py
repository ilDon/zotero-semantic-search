import os
import glob
import PyPDF2
import numpy as np
from typing import List
from sklearn.metrics.pairwise import cosine_similarity
import json
import hashlib
from datetime import date
import asyncio

from src.database import DatabaseHelper
from src.embedder import getTextEmbedding
from src.server import socketio

cached_results = None

class LibraryFinder:

    def __init__(self, search_folder="test_files"):
        self.search_folder = search_folder
        db_folder = os.path.dirname(os.path.abspath(search_folder))
        self.db = DatabaseHelper(db_folder=db_folder)

    def query_files(self, query: str) -> List:
        hash_object = hashlib.sha256(query.encode('utf-8'))
        query_hash = hash_object.hexdigest()
        query_embedding = self.get_query_embedding(query)
        rows = self.fetch_database_rows()
        results = self.calculate_similarities(query_embedding, rows)
        serialized_results = json.dumps(results)
        today = date.today().strftime("%Y-%m-%d")
        self.db.write("INSERT INTO history (id, query, query_embedding, results, date) VALUES (?, ?, ?, ?, ?)",
                            (query_hash, query, json.dumps(query_embedding.tolist()), serialized_results, today))
        self.db.close()
        return [query_hash, results]

    def get_query_embedding(self, query: str) -> np.ndarray:
        return getTextEmbedding([query]).numpy()

    def fetch_database_rows(self) -> List:
        global cached_results
        if cached_results:
            return cached_results
        cached_results = self.db.read("SELECT id, file_name, section_number, embedding FROM embeddings")
        return cached_results

    def send_progress(self, progress: int):
        socketio.emit('progress', json.dumps({"progress": progress}))

    def calculate_similarities(self, query_embedding: np.ndarray, rows: List) -> List:
        results = []
        total_len = len(rows)
        previous_progress = 0
        for i, row in enumerate(rows):
            folder_id, file_name, section_number, embedding = row
            embedding = np.array([json.loads(embedding)])
            
            progress = int((i + 1) / total_len * 100)
            if progress > previous_progress:
              self.send_progress(progress)
              previous_progress = progress

            if embedding.shape != query_embedding.shape:
                print(f"ERROR: Embedding shape mismatch for {file_name} section {section_number}")
                continue
            
            similarity = cosine_similarity(query_embedding, embedding)[0][0]
            if similarity > 0.6:
              results.append({
                "similarity": similarity, 
                "folder_id": folder_id, 
                "file_name": file_name, 
                "section_number": section_number
              })
        return results
