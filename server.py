from flask import Flask, request, jsonify
from src.library_processor import LibraryProcessor
from src.library_finder import LibraryFinder
from flask_cors import CORS

app = Flask(__name__)
CORS(app) # Enable CORS for all routes

@app.route('/process', methods=['POST'])
def process_files():
    search_folder = request.args.get('search_folder', 'test_files')
    processor = LibraryProcessor(search_folder=search_folder)
    processor.process_files()
    return jsonify({"status": "success", "message": "Files processed successfully"}), 200

@app.route('/query', methods=['POST'])
def query_files():
    search_folder = request.args.get('search_folder', 'test_files')
    query = request.args.get('query', '')
    finder = LibraryFinder(search_folder=search_folder)
    results = finder.query_files(query)
    return jsonify({"status": "success", "results": results}), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3003, debug=True)
