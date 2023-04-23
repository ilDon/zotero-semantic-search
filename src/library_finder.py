import os
import glob
import PyPDF2
import docx2txt
import numpy as np
from typing import List
from sklearn.metrics.pairwise import cosine_similarity
import json

from src.database import DatabaseHelper
from src.embedder import getTextEmbedding

class LibraryFinder:

    def __init__(self, search_folder="test_files"):
        self.search_folder = search_folder
        db_folder = os.path.dirname(os.path.abspath(search_folder))
        DatabaseHelper.init(db_folder=db_folder)

    def query_files(self, query: str) -> List:
        query_embedding = self.get_query_embedding(query)
        rows = self.fetch_database_rows()
        results = self.calculate_similarities(query_embedding, rows)
        top_results = self.get_top_results(results, 10)
        return top_results

    def get_query_embedding(self, query: str) -> np.ndarray:
        return getTextEmbedding([query]).numpy()

    def fetch_database_rows(self) -> List:
        return DatabaseHelper.read("SELECT id, file_name, section_number, embedding FROM embeddings")

    def calculate_similarities(self, query_embedding: np.ndarray, rows: List) -> List:
        results = []
        total_len = len(rows)
        for i, row in enumerate(rows):
            print(f'\r- Searching file: {i + 1}/{total_len}', end='')
            folder_id, file_name, section_number, embedding = row
            embedding = np.array([json.loads(embedding)])
            similarity = cosine_similarity(query_embedding, embedding)[0][0]
            results.append((similarity, folder_id, file_name, section_number))
        return results

    def get_top_results(self, results: List, n: int) -> List:
        return sorted(results, key=lambda x: x[0], reverse=True)[:n]

    # @deprecated
    def display_results(self, results: List):
        for result in results:
            print(f"Folder ID: {result[1]}, File: {result[2]}, Section: {result[3]}, "
                  f"Similarity: {result[0]:.4f}")
