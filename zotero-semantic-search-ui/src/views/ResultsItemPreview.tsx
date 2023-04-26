import * as React from 'react';
import { ISearchResult } from '../ResultsContext';
import { ResultItemPreviewItem } from './ResultItemPreviewItem';
import { Api } from '../modules/api';

interface IRResultsItemPreviewProps {
  folderId: string;
  result: ISearchResult;
}

const SECTION_TEXTS_CACHE: Record<string, Array<string>> = {};

export const ResultsItemPreview: React.FC<IRResultsItemPreviewProps> = React.memo(function ResultsItemPreview(props: IRResultsItemPreviewProps) {
  const [sectionsText, setSectionsText] = React.useState<Array<string>>([]);

  React.useEffect(() => {
    const fetchSections = async () => {
      if (SECTION_TEXTS_CACHE[props.folderId]) {
        setSectionsText(SECTION_TEXTS_CACHE[props.folderId]);
        return;
      }
      const sections = await Api.sectionsText(props.folderId);
      SECTION_TEXTS_CACHE[props.folderId] = sections;
      setSectionsText(sections);
    };
    fetchSections();
  }, [props.folderId]);

  if (!sectionsText?.[props.result.section_number]) {
    return <p>Loading...</p>;
  }

  return (
    <ResultItemPreviewItem key={props.result.section_number} score={props.result.similarity} section={props.result.section_number} text={sectionsText[props.result.section_number]} />
  )
});
