import os
import glob
import PyPDF2
import numpy as np
from typing import List
import json
import resource

from src.database import DatabaseHelper
from src.embedder import getTextEmbedding
from src.const import MAX_SECTION_CHARS

class LibraryProcessor:

    def __init__(self, search_folder="test_files"):
        soft_limit, hard_limit = resource.getrlimit(resource.RLIMIT_NOFILE)
        resource.setrlimit(resource.RLIMIT_NOFILE, (hard_limit, hard_limit))

        self.search_folder = search_folder
        db_folder = os.path.dirname(os.path.abspath(search_folder))
        DatabaseHelper.init(db_folder=db_folder)
        DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS embeddings (
                      id TEXT, file_name TEXT, section_number INTEGER, 
                      embedding TEXT)""")
        DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS excluded (
                      id TEXT, reason TEXT)""")
        self.processed_folder_ids = self.get_processed_folder_ids("embeddings")
        self.excluded_folder_ids = self.get_processed_folder_ids("excluded")

    def get_processed_folder_ids(self, table_name: str):
        folder_ids = set()
        rows = DatabaseHelper.read(f"SELECT DISTINCT id FROM {table_name}")
        for row in rows:
            folder_ids.add(row[0])
        return folder_ids

    def extract_text_from_file(self, file: str, folder_id: str) -> str:
        file_text = ""
        with open(file, "rb") as pdf_file:
            with open(os.devnull, 'w') as devnull:
                original_stderr = os.dup(2)
                os.dup2(devnull.fileno(), 2)
                try:
                    print(f"\n\nProcessing file: {pdf_file.name}\n")
                    print(f"Folder: {folder_id}\n")
                    reader = PyPDF2.PdfReader(pdf_file)
                    if not reader.is_encrypted:  # Check if the PDF is not encrypted
                        len_pages = len(reader.pages)
                        for page in range(len_pages):
                            file_text += reader.pages[page].extract_text()
                    else:
                        # add to excluded in DB
                        DatabaseHelper.write("INSERT INTO excluded VALUES (?, ?)",
                                             (folder_id, "encrypted"))
                        print(f"\n\nSkipping encrypted file: {pdf_file.name}\n")
                finally:
                    reader = None
                    os.dup2(original_stderr, 2)
                    devnull.close()
                    pdf_file.close()
      
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
        
        # Generate a list of all PDF files
        pdf_files = []
        for folder in glob.glob(path_to_scan):
            folder_id = os.path.basename(folder)
            if folder_id in self.processed_folder_ids or folder_id in self.excluded_folder_ids:
                continue
            for file in glob.glob(f"{folder}/*"):
                if file.endswith(".pdf"):
                    pdf_files.append((folder, file))

        # Process the list of PDF files
        total_len = len(pdf_files)
        for i, (folder, file) in enumerate(pdf_files):
            print(f'\r- Processing file: {i + 1}/{total_len}', end='')

            folder_id = os.path.basename(folder)
            file_name = os.path.basename(file)
            file_text = self.extract_text_from_file(file, folder_id)
            sections = self.split_and_truncate(file_text)

            # Check sections length is > 0 and all sections are not empty
            if len(sections) == 0 or all([len(section) == 0 for section in sections]):
                continue

            embeddings = getTextEmbedding(sections)
            self.save_embeddings(folder_id, file_name, sections, embeddings)

        
