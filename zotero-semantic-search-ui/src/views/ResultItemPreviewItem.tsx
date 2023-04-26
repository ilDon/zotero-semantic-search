import * as React from 'react';
import { Api } from '../modules/api';

interface IResultItemPreviewItemProps {
  folderId: string;
  score: number;
  section: number;
  text: string;
}

export const ResultItemPreviewItem: React.FC<IResultItemPreviewItemProps> = (props: IResultItemPreviewItemProps) => {
  const handleOpenFile = () => {
    Api.openFile(props.folderId);
  };
  return (
  <div className="overflow-hidden bg-white">
    <div className="">
      <div className="flex space-x-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">
            Score: {props.score}
            <span className="ml-2 text-sm text-gray-500">
              Section: {props.section} - {props.folderId}
            </span>
          </p>
        </div>
      </div>
      <div className="pb-5 text-gray-500">
        <p>{props.text}</p>
      </div>
      <button
        type="button"
        className="rounded-md bg-indigo-600 disabled:bg-indigo-500 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
        onClick={handleOpenFile}
      >
        Open PDF
      </button>
    </div>
  </div>
)
}
