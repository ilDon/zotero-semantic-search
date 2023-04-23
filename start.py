from src.library_finder import LibraryFinder
from src.library_processor import LibraryProcessor
from src.database import DatabaseHelper

LibraryProcessor().process_files()
LibraryFinder().query_files()
DatabaseHelper.close()