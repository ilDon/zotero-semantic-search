import axios from 'axios';
import { SearchFolder } from './search-folder';
import { ISearchResult } from '../ResultsContext';

interface IQueryPayload {
  query: string;
  search_folder: string;
}

interface IApiResponse<T> {
  data: {
    results: T;
    status: "success"
  }
}

const BASE_URL = 'http://127.0.0.1:3003';

export class Api {
  public static async query(query: string): Promise<Array<ISearchResult>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IQueryPayload, IApiResponse<Array<ISearchResult>>> (`${BASE_URL}/query`, { query, search_folder: searchFolder });
    return response?.data?.results || [];
  }
}