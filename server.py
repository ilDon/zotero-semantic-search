import os
import glob
from flask import Flask, request, jsonify
from flask_cors import CORS

from src.library_processor import LibraryProcessor
from src.library_finder import LibraryFinder
from src.pdf_parser import PdfParser
from src.database import DatabaseHelper

app = Flask(__name__)
CORS(app) # Enable CORS for all routes

@app.route('/scan', methods=['POST'])
def process_files():
    data = request.get_json()
    search_folder = data.get('search_folder')
    
    if not search_folder:
        return jsonify({"error": "search_folder parameter is required"}), 400
    
    processor = LibraryProcessor(search_folder=search_folder)
    processor.process_files()
    DatabaseHelper.close()
    return jsonify({"status": "success", "message": "Files processed successfully"}), 200

@app.route('/query', methods=['POST'])
def query_files():
    data = request.get_json()
    search_folder = data.get('search_folder', 'test_files')
    query = data.get('query', '')
    
    if not search_folder or not query:
        return jsonify({"error": "search_folder and query parameters are required"}), 400
    
    finder = LibraryFinder(search_folder=search_folder)
    [query_hash, results] = finder.query_files(query)
    DatabaseHelper.close()
    return jsonify({"status": "success", "results": results, "id": query_hash}), 200

@app.route('/pdf_sections', methods=['POST'])
def get_pdf_sections():
    data = request.get_json()
    search_folder = data.get('search_folder')
    folder_id = data.get('folder_id')

    if not search_folder or not folder_id:
        return jsonify({"error": "search_folder and folder_id parameters are required"}), 400

    pdf_file_path = None
    folder_blob = f"{search_folder}/{folder_id}/*"
    for file in glob.glob(folder_blob):
        if file.endswith(".pdf"):
            pdf_file_path = file
            break

    if not pdf_file_path:
        return jsonify({"error": f"No PDF file found in {folder_blob}"}), 404

    sections = PdfParser.parse_pdf_by_folder(pdf_file_path, folder_id)
    return jsonify({"status": "success", "results": sections})

@app.route('/get_history', methods=['POST', 'OPTIONS'])
def get_history():
    
    if request.method == 'OPTIONS':
        return jsonify({"status": "success"}), 200
    
    data = request.get_json()
    search_folder = data.get('search_folder')
    
    if not search_folder:
        return jsonify({"error": "search_folder parameter is required"}), 400
    
    db_folder = os.path.dirname(os.path.abspath(search_folder))
    DatabaseHelper.init(db_folder=db_folder)
    rows = DatabaseHelper.read("SELECT id, query, results, date FROM history")
    DatabaseHelper.close()

    results = []
    for row in rows:
        result = {
            "id": row[0],
            "query": row[1],
            "results": row[2],
            "date": row[3]
        }
        results.append(result)

    return jsonify({"status": "success", "results": results}), 200

@app.route('/fetch_history_element', methods=['POST'])
def fetch_history_element():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('id')
    
    if not search_folder or not id:
        return jsonify({"error": "search_folder and id parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    DatabaseHelper.init(db_folder=db_folder)
    row = DatabaseHelper.read("SELECT id, query, results, date FROM history WHERE id = ?", (id,))
    DatabaseHelper.close()

    if not row:
        return jsonify({"error": f"No history item found with id {id}"}), 404
    first_row = row[0]
    result = {
        "id": first_row[0],
        "query": first_row[1],
        "results": first_row[2],
        "date": first_row[3]
    }

    return jsonify({"status": "success", "results": result}), 200

@app.route('/delete_history_element', methods=['POST'])
def delete_history():
    data = request.get_json()
    search_folder = data.get('search_folder')
    id = data.get('id')
    
    if not search_folder or not id:
        return jsonify({"error": "search_folder and id parameters are required"}), 400

    db_folder = os.path.dirname(os.path.abspath(search_folder))
    DatabaseHelper.init(db_folder=db_folder)
    DatabaseHelper.write("DELETE FROM history WHERE id = ?", (id,))
    DatabaseHelper.close()
    return jsonify({"status": "success", "message": "History item deleted successfully"}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3003, debug=True)