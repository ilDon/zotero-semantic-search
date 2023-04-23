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
from src.const import MAX_SECTION_CHARS

class LibraryProcessor:

    def __init__(self, search_folder="test_files"):
        self.search_folder = search_folder
        db_folder = os.path.dirname(os.path.abspath(search_folder))
        DatabaseHelper.init(db_folder=db_folder)
        DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS embeddings (
                      id TEXT, file_name TEXT, section_number INTEGER, 
                      embedding TEXT)""")
        self.processed_folder_ids = self.get_processed_folder_ids()

    def get_processed_folder_ids(self):
        folder_ids = set()
        rows = DatabaseHelper.read("SELECT DISTINCT id FROM embeddings")
        for row in rows:
            folder_ids.add(row[0])
        return folder_ids

    def extract_text_from_file(self, file: str) -> str:
        file_text = ""
        if file.endswith(".pdf"):
            with open(file, "rb") as pdf_file:
                with open(os.devnull, 'w') as devnull:
                    original_stderr = os.dup(2)
                    os.dup2(devnull.fileno(), 2)
                    try:
                        reader = PyPDF2.PdfReader(pdf_file)
                        len_pages = len(reader.pages)
                        for page in range(len_pages):
                            file_text += reader.pages[page].extract_text()
                    finally:
                        os.dup2(original_stderr, 2)
        elif file.endswith(".docx"):
            file_text = docx2txt.process(file)
        
        return file_text

    def split_and_truncate(self, text: str) -> List[str]:
        return [text[i:i + MAX_SECTION_CHARS] for i in range(0, len(text), MAX_SECTION_CHARS)]

    def save_embeddings(self, folder_id: str, file_name: str, sections: List[str], embeddings: np.ndarray):
        for idx, section in enumerate(sections):
            embedding = embeddings[idx].numpy()
            embedding_as_json_string = json.dumps(embedding.tolist())
            DatabaseHelper.write("INSERT INTO embeddings VALUES (?, ?, ?, ?)",
                                 (folder_id, file_name, idx, embedding_as_json_string))

    def process_files(self):
        path_to_scan = f"{self.search_folder}/*"
        total_len = len(glob.glob(path_to_scan))
        i = 0
        for folder in glob.glob(path_to_scan):
            print(f'\r- Processing file: {i + 1}/{total_len}', end='')
            i += 1
            folder_id = os.path.basename(folder)
            if folder_id in self.processed_folder_ids:
                continue
            for file in glob.glob(f"{folder}/*"):
                file_name = os.path.basename(file)
                file_text = self.extract_text_from_file(file)
                sections = self.split_and_truncate(file_text)
                embeddings = getTextEmbedding(sections)
                self.save_embeddings(folder_id, file_name, sections, embeddings)
        
