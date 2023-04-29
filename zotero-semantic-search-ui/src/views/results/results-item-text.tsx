import * as React from 'react';

interface IResultsItemTextProps {
  text: string;
}

export const ResultsItemText: React.FC<IResultsItemTextProps> = (props: IResultsItemTextProps) => {
  // remove Non Breakable SPace and end of line
  const cleanText = props.text.replace(/\u00a0/g, ' ').replace(/\n/g, ' ');
  return (
    <div className="flex items-center justify-center">
      <div className="max-w-[1000px] rounded-lg shadow-lg border border-solid border-gray-200 border-opacity-90 p-5 my-4">
        <p className="text-gray-600 text-justify text-lg">{cleanText}</p>
      </div>
    </div>
  );
};
