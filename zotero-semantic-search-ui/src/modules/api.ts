import axios from 'axios';
import { SearchFolder } from './search-folder';
import { ISearchResult } from '../ResultsContext';

interface IBasePayload {
  search_folder: string;
}

interface IQueryPayload extends IBasePayload {
  query: string;
}

interface ISectionsTextPayload extends IBasePayload {
  folderId: string;
}

interface IApiResponse<T> {
  data: {
    results: T;
    status: "success"
  }
}

export interface IHistoryItem {
  id: string;
  query: string;
  results: Array<ISearchResult>;
  date: string;
}

const BASE_URL = 'http://127.0.0.1:3003';

export class Api {

  public static async scan(): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/scan`, { search_folder: searchFolder });
  }

  public static async query(query: string): Promise<Array<ISearchResult>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IQueryPayload, IApiResponse<Array<ISearchResult>>> (`${BASE_URL}/query`, { query, search_folder: searchFolder });
    return response?.data?.results || [];
  }
  
  public static async sectionsText(folderId: string): Promise<Array<string>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<ISectionsTextPayload, IApiResponse<Array<string>>> (`${BASE_URL}/pdf_sections`, { search_folder: searchFolder, folder_id: folderId});
    return response?.data?.results || [];
  }

  public static async history(): Promise<Array<IHistoryItem>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IBasePayload, IApiResponse<Array<IHistoryItem>>> (`${BASE_URL}/get_history`, { search_folder: searchFolder });
    if (response?.data?.results?.length) {
      response.data.results.forEach((item: IHistoryItem) => {
        item.results = JSON.parse(item.results as any);
      });
    }
    return response?.data?.results || [];
  }

  public static async deleteHistoryElement(id: string): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/delete_history_element`, { search_folder: searchFolder, id });
  }

}