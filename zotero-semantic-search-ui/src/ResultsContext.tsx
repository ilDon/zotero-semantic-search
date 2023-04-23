import * as React from 'react';

export interface ISearchResult {
  similarity: number;
  folderId: string;
  fileName: string;
  sectionNumber: number;
}

interface ResultsContextValue {
  results: ISearchResult[];
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
  const [results, setResults] = React.useState<ISearchResult[]>([]);

  return (
    <ResultsContext.Provider value={{ results, setResults }}>
      {props.children}
    </ResultsContext.Provider>
  );
};
