import * as React from 'react';
import { ISearchResult, useResults } from '../ResultsContext';

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
    <div className="container mx-auto py-5">
      <h1 className="text-3xl mb-5">Results</h1>
      <p>{query}</p>
      {Object.entries(resultsByFolder).map(([folderId, results]) => (
        <div key={folderId} className="mb-5">
          <h2 className="text-2xl mb-2">{results?.[0].file_name || folderId}</h2>
          {results.map((result) => (
            <div key={result.section_number} className="mb-2">
              {result.section_number}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
};
