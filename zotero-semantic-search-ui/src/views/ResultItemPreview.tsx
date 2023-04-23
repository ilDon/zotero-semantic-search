import * as React from 'react';

interface IResultItemPreviewProps {
  score: number;
  section: number;
  text: string;
}

export const ResultItemPreview: React.FC<IResultItemPreviewProps> = (props: IResultItemPreviewProps) => (
  <div className="overflow-hidden bg-white">
    <div className="">
      <div className="flex space-x-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">
            Score: {props.score}
            <span className="ml-2 text-sm text-gray-500">
              Section: {props.section}
            </span>
          </p>
        </div>
      </div>
      <div className="pb-5 text-gray-500">
        <p>{props.text}</p>
      </div>
    </div>
  </div>
)
