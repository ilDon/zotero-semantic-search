import * as React from 'react';
import { Api } from '../../modules/api';

export enum Status {
  todo = 0,
  analyzed = 1,
  irrelevant = 2
}

export interface ISearchResult {
  similarity: number;
  folder_id: string;
  file_name: string;
  section_number: number;
  status?: Status;
}

interface ResultsContextValue {
  query: string;
  results: Array<ISearchResult>;
  setQuery: (query: string) => void;
  setResults: (results: ISearchResult[]) => void;
  updateResultStatus: (index: number, status: Status, historyElementId: string) => void;
}

const ResultsContext = React.createContext<ResultsContextValue | undefined>(undefined);

export const useResults = () => {
  const context = React.useContext(ResultsContext);
  if (!context) {
    throw new Error('useResults must be used within a ResultsProvider');
  }
  return context;
};

interface IResultsProviderProps {
  children: React.ReactNode;
}

export const ResultsProvider: React.FC<IResultsProviderProps> = (props: IResultsProviderProps) => {
  const [query, setQuery] = React.useState<string>('');
  const [results, setResults] = React.useState<ISearchResult[]>([]);

  const updateResultStatus = React.useCallback((index: number, status: Status, historyElementId: string) => {
    setResults((prev) => {
      const newResults = [...prev];
      newResults[index].status = status;
      new Api().updateHistoryElement(historyElementId, newResults);
      return newResults;
    });
  }, []);

  return (
    <ResultsContext.Provider value={{ query, results, setQuery, setResults, updateResultStatus }}>
      {props.children}
    </ResultsContext.Provider>
  );
};
