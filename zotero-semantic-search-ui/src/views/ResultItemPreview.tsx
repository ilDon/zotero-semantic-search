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
        <p>Lorem ipsum dolor sit, amet consectetur adipisicing elit. Illo impedit sapiente recusandae iusto officiis dolor? Laborum quibusdam quam, quidem vel assumenda repellat inventore sint nesciunt, ullam asperiores magnam placeat eveniet. Aliquam voluptatibus assumenda distinctio veniam quam tempora modi aperiam nemo voluptate reprehenderit quidem, nisi vero est.</p>
      </div>
    </div>
  </div>
)
