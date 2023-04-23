import os
import PyPDF2
from typing import List

from src.database import DatabaseHelper
from src.const import MAX_SECTION_CHARS

class PdfParser:

  @staticmethod
  def parse_pdf_by_folder(file: str, folder_id: str) -> List[str]:
      file_text = PdfParser.extract_text_from_file(file, folder_id)
      sections = PdfParser.split_and_truncate(file_text)
      return sections

  @staticmethod
  def extract_text_from_file(file: str, folder_id: str) -> str:
        file_text = ""
        with open(file, "rb") as pdf_file:
            with open(os.devnull, 'w') as devnull:
                original_stderr = os.dup(2)
                os.dup2(devnull.fileno(), 2)
                try:
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

  @staticmethod
  def split_and_truncate(text: str) -> List[str]:
      return [text[i:i + MAX_SECTION_CHARS] for i in range(0, len(text), MAX_SECTION_CHARS)]