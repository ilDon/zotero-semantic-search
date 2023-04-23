from src.library_processor import LibraryProcessor
from src.database import DatabaseHelper

LibraryProcessor().process_files()
DatabaseHelper.close()