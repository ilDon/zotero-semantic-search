import axios from 'axios';
import { SearchFolder } from './search-folder';
import type { ISearchResult } from '../views/results/results-provider';

interface IBasePayload {
  search_folder: string;
}

interface IQueryPayload extends IBasePayload {
  query: string;
}

interface ISectionsTextPayload extends IBasePayload {
  folderId: string;
}

interface IHistoryItemPayload extends IBasePayload {
  id: string;
}

interface IApiResponse<T> {
  data: {
    results: T;
    status: "success"
  }
}

interface IQueryResponse {
  data: {
    results: Array<ISearchResult>;
    status: "success"
    id: string;
  }
}

export interface IHistoryItem {
  id: string;
  query: string;
  results: Array<ISearchResult>;
  date: string;
}

export interface IExcludedFolder {
  id: string;
  reason: 'encrypted' | 'no_text' | 'manual';
  date: string
  file_name: string;
}

export const BASE_URL = 'http://127.0.0.1:5000';

export class Api {

  public async scan(): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/scan`, { search_folder: searchFolder });
  }

  public async query(query: string): Promise<{ results: Array<ISearchResult>, id: string }> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IQueryPayload, IQueryResponse> (`${BASE_URL}/query`, { query, search_folder: searchFolder });
    return { results: response?.data?.results || [], id: response?.data?.id || ''};
  }
  
  public async sectionsText(folderId: string): Promise<Array<string>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<ISectionsTextPayload, IApiResponse<Array<string>>> (`${BASE_URL}/pdf_sections`, { search_folder: searchFolder, folder_id: folderId});
    return response?.data?.results || [];
  }

  public async openFile(folderId: string): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post<ISectionsTextPayload>(`${BASE_URL}/open_file`, { search_folder: searchFolder, folder_id: folderId });
  }

  public async history(): Promise<Array<IHistoryItem>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IBasePayload, IApiResponse<Array<IHistoryItem>>> (`${BASE_URL}/get_history`, { search_folder: searchFolder });
    if (response?.data?.results?.length) {
      response.data.results.forEach((item: IHistoryItem) => {
        item.results = JSON.parse(item.results as any);
      });
    }
    return response?.data?.results || [];
  }

  public async fetchHistoryElement(id: string): Promise<IHistoryItem> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IHistoryItemPayload, IApiResponse<IHistoryItem>>(`${BASE_URL}/fetch_history_element`, { search_folder: searchFolder, id });
    const item = response?.data?.results;
    if (item) {
      item.results = JSON.parse(item.results as any);
    }
    return item;
  }

  public async updateHistoryElement(id: string, results: Array<ISearchResult>): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/update_history_element`, { search_folder: searchFolder, id, results: JSON.stringify(results) });
  }

  public async deleteHistoryElement(id: string): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/delete_history_element`, { search_folder: searchFolder, id });
  }

  public async getExcluded(): Promise<Array<IExcludedFolder>> {
    const searchFolder = SearchFolder.getSearchFolder();
    const response = await axios.post<IBasePayload, IApiResponse<Array<IExcludedFolder>>>(`${BASE_URL}/get_excluded`, { search_folder: searchFolder });
    return response?.data?.results || [];
  }

  public async addExcluded(folderId: string, reason: IExcludedFolder['reason']): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/add_excluded`, { search_folder: searchFolder, folder_id: folderId, reason });
  }

  public async deleteExcluded(folderId: string): Promise<void> {
    const searchFolder = SearchFolder.getSearchFolder();
    await axios.post(`${BASE_URL}/delete_excluded`, { search_folder: searchFolder, folder_id: folderId });
  }

}