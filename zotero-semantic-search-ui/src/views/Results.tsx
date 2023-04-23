import * as React from 'react';
import { ISearchResult, useResults } from '../ResultsContext';
import { ResultsItem } from './ResultsItem';

export const Results: React.FC = () => {
  const { query, results } = useResults();
  
  const resultsByFolder: Record<string, ISearchResult[]> = React.useMemo(() => {
    const resultsByFolder: Record<string, ISearchResult[]> = {};
    const sortedResults = results.sort((a, b) => b.similarity - a.similarity);
    sortedResults.forEach((result) => {
      if (!resultsByFolder[result.folder_id]) {
        resultsByFolder[result.folder_id] = [];
      }
      resultsByFolder[result.folder_id].push(result);
    });
    // sort by similarity
    
    return resultsByFolder;
  }, [results]);

  return (
    <div className="container mx-auto">
      <h1 className="text-3xl mb-5">Results</h1>
      <label className="text-sm text-gray-400">Query:</label>
      <p className="text-sm text-gray-500 mb-8">{query}</p>
      {Object.entries(resultsByFolder).map(([folderId, results]) => (
        <ResultsItem key={folderId} folderId={folderId} results={results} />
      ))}
    </div>
  );
};
