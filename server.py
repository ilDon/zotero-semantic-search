import glob
from flask import Flask, request, jsonify
from flask_cors import CORS

from src.library_processor import LibraryProcessor
from src.library_finder import LibraryFinder
from src.pdf_parser import PdfParser

app = Flask(__name__)
CORS(app) # Enable CORS for all routes

@app.route('/process', methods=['POST'])
def process_files():
    search_folder = request.args.get('search_folder', 'test_files')
    
    if not search_folder or not folder_id:
        return jsonify({"error": "search_folder parameter is required"}), 400
    
    processor = LibraryProcessor(search_folder=search_folder)
    processor.process_files()
    return jsonify({"status": "success", "message": "Files processed successfully"}), 200

@app.route('/query', methods=['POST'])
def query_files():
    search_folder = request.args.get('search_folder', 'test_files')
    query = request.args.get('query', '')
    
    """ if not search_folder or not query:
        return jsonify({"error": "search_folder and query parameters are required"}), 400 """
    
    finder = LibraryFinder(search_folder=search_folder)
    results = finder.query_files(query)
    return jsonify({"status": "success", "results": results}), 200

@app.route('/pdf_sections', methods=['POST'])
def get_pdf_sections():
    search_folder = request.args.get('search_folder')
    folder_id = request.args.get('folder_id')

    """ if not search_folder or not folder_id:
        return jsonify({"error": "search_folder and folder_id parameters are required"}), 400 """

    pdf_file_path = None
    for file in glob.glob(f"{search_folder}/{folder_id}/*"):
        if file.endswith(".pdf"):
            pdf_file_path = file
            break

    """ if not pdf_file_path:
        return jsonify({"error": "No PDF file found in the specified folder"}), 404 """

    sections = PdfParser.parse_pdf_by_folder(pdf_file_path, folder_id)

    return jsonify({"status": "success", "results": sections})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3003, debug=True)
