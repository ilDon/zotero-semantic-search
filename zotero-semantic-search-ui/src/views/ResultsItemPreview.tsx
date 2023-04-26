import * as React from 'react';
import { ISearchResult } from '../ResultsContext';
import { ResultItemPreviewItem } from './ResultItemPreviewItem';
import { usePdfText } from '../providers/pdf-text-provider';

interface IRResultsItemPreviewProps {
  folderId: string;
  result: ISearchResult;
}

export const ResultsItemPreview: React.FC<IRResultsItemPreviewProps> = React.memo(function ResultsItemPreview(props: IRResultsItemPreviewProps) {
  const { getSectionText } = usePdfText();
  const sectionsText = getSectionText(props.folderId);

  if (!sectionsText?.[props.result.section_number]) {
    return <p>Loading...</p>;
  }

  return (
    <ResultItemPreviewItem
      key={props.result.section_number}
      folderId={props.folderId}
      score={props.result.similarity}
      section={props.result.section_number}
      text={sectionsText[props.result.section_number]}
    />
  )
});
