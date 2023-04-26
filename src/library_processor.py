import os
import glob
import PyPDF2
import numpy as np
from typing import List
import json
from datetime import date

from src.database import DatabaseHelper
from src.embedder import getTextEmbedding
from src.const import MAX_SECTION_CHARS
from src.pdf_parser import PdfParser

class LibraryProcessor:

    def __init__(self, search_folder="test_files"):
        self.search_folder = search_folder
        db_folder = os.path.dirname(os.path.abspath(search_folder))
        DatabaseHelper.init(db_folder=db_folder)
        self.processed_folder_ids = self.get_processed_folder_ids("embeddings")
        self.excluded_folder_ids = self.get_processed_folder_ids("excluded")

    def get_processed_folder_ids(self, table_name: str):
        folder_ids = set()
        rows = DatabaseHelper.read(f"SELECT DISTINCT id FROM {table_name}")
        for row in rows:
            folder_ids.add(row[0])
        return folder_ids

    def save_embeddings(self, folder_id: str, file_name: str, sections: List[str]):
        total_len = len(sections)
        for idx, section in enumerate(sections):
            print(f'\r  - Processing section: {idx + 1}/{total_len}', end='')
            embeddings = getTextEmbedding([section])
            embedding = embeddings.numpy()
            embedding_as_json_string = json.dumps(embedding.tolist()[0])
            today = date.today().strftime("%Y-%m-%d")
            DatabaseHelper.write("INSERT INTO embeddings (id, file_name, section_number, embedding, date) VALUES (?, ?, ?, ?, ?)",
                                 (folder_id, file_name, idx, embedding_as_json_string, today))

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
            print(f'\n- Processing file: {i + 1}/{total_len} - {file}\n', end='')

            folder_id = os.path.basename(folder)
            file_name = os.path.basename(file)
            sections = PdfParser.parse_pdf_by_folder(file, folder_id)

            # Check sections length is > 0 and all sections are not empty
            if len(sections) == 0 or all([len(section) == 0 for section in sections]):
                today = date.today().strftime("%Y-%m-%d")
                DatabaseHelper.write("INSERT INTO excluded (id, reason, date) VALUES (?, ?, ?)", (folder_id, "no_text", today))
                continue

            self.save_embeddings(folder_id, file_name, sections)

        
