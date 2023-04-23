import React, { createContext, useContext, useState } from 'react';

interface Result {
  similarity: number;
  folderId: string;
  fileName: string;
  sectionNumber: number;
}

interface ResultsContextValue {
  results: Result[];
  setResults: (results: Result[]) => void;
}

const ResultsContext = createContext<ResultsContextValue | undefined>(undefined);

export const useResults = () => {
  const context = useContext(ResultsContext);
  if (!context) {
    throw new Error('useResults must be used within a ResultsProvider');
  }
  return context;
};

interface IResultsProviderProps {
  children: React.ReactNode;
}

export const ResultsProvider: React.FC<IResultsProviderProps> = (props: IResultsProviderProps) => {
  const [results, setResults] = useState<Result[]>([]);

  return (
    <ResultsContext.Provider value={{ results, setResults }}>
      {props.children}
    </ResultsContext.Provider>
  );
};
