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

  def __init__(self):
    DatabaseHelper.init()
    DatabaseHelper.write("""CREATE TABLE IF NOT EXISTS embeddings (
                  id TEXT, file_name TEXT, section_number INTEGER, 
                  embedding TEXT)""")

  def process_files(self):
    # Traverse through the files
    for folder in glob.glob("test_files/*"):
        folder_id = os.path.basename(folder)
        for file in glob.glob(f"{folder}/*"):
            file_name = os.path.basename(file)
            file_text = ""
            if file.endswith(".pdf"):
                with open(file, "rb") as pdf_file:
                    reader = PyPDF2.PdfReader(pdf_file)
                    len_pages = len(reader.pages)
                    for page in range(len_pages):
                        file_text += reader.pages[page].extract_text()
            # elif file.endswith(".docx"):
              #  file_text = docx2txt.process(file)

            # Split and truncate the contents
            sections = [file_text[i:i + MAX_SECTION_CHARS] for i in range(0, len(file_text), MAX_SECTION_CHARS)]

            # Generate and save the embeddings
            embeddings = getTextEmbedding(sections)
            for idx, section in enumerate(sections):
                embedding = embeddings[idx].numpy()
                embedding_as_json_string = json.dumps(embedding.tolist())
                DatabaseHelper.write("INSERT INTO embeddings VALUES (?, ?, ?, ?)",
                              (folder_id, file_name, idx, embedding_as_json_string))
    DatabaseHelper.close()