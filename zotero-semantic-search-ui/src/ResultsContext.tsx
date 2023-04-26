import * as React from 'react';

export interface ISearchResult {
  similarity: number;
  folder_id: string;
  file_name: string;
  section_number: number;
}

interface ResultsContextValue {
  query: string;
  results: Array<ISearchResult>;
  setQuery: (query: string) => void;
  setResults: (results: ISearchResult[]) => void;
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

  return (
    <ResultsContext.Provider value={{ query, results, setQuery, setResults }}>
      {props.children}
    </ResultsContext.Provider>
  );
};
