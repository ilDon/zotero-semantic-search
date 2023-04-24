import * as React from 'react';
import { ISearchResult } from '../ResultsContext';
import { ResultItemPreviewItem } from './ResultItemPreviewItem';
import { Api } from '../modules/api';

interface IRResultsItemPreviewProps {
  folderId: string;
  results: Array<ISearchResult>;
}

export const ResultsItemPreview: React.FC<IRResultsItemPreviewProps> = React.memo(function ResultsItemPreview(props: IRResultsItemPreviewProps) {
  const [sectionsText, setSectionsText] = React.useState<Array<string>>([]);

  React.useEffect(() => {
    const fetchSections = async () => {
      const sections = await Api.sectionsText(props.folderId);
      setSectionsText(sections);
    };
    if(!sectionsText.length){
      fetchSections();
    }
  }, [props.folderId, sectionsText]);

  return (
    <>
      {props.results.map((result) => (
        <ResultItemPreviewItem key={result.section_number} score={result.similarity} section={result.section_number} text={sectionsText[result.section_number]} />
      ))}
    </>
  )
});
