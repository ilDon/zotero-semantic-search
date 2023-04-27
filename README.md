# Semantic Search

## Introduction

This is a semantic search engine that uses the Bert-based model [LEALLA](https://tfhub.dev/google/LEALLA/LEALLA-large/1) to encode a corpus of documents into vectors and then uses cosine similarity to find the most similar documents to a given query.

## Usage

### 1. Install dependencies

    yarn install

    pip install -r requirements.txt // TODO

On macOS, you may need to install `tensorflow-macos`. Additionally, it will be necessary to build `tensorflow-text` from source.

To do so:

Download tensorflow_text-2.x.x-cpxxx-cpxxx-macosx_11_0_arm64.whl (version will depend on machine and time of reading) from here https://github.com/sun1638650145/Libraries-and-Extensions-for-TensorFlow-for-Apple-Silicon/releases.

Then within your virtual environment go to the folder you downloaded it and do 

    pip install tensorflow_text-....

### 2. Run the app

    yarn start