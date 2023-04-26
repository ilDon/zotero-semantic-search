import * as React from 'react';
import { SearchFolder } from '../modules/search-folder';

interface IFileNameWithId {
  id: string;
  fileName: string;
}

export const FileNameWithId: React.FC<IFileNameWithId> = (props) => {
  const search_folder = SearchFolder.getSearchFolder();
  const search_folder_name = search_folder?.replace(/\//g, '\\');
  const cleaned_file_name = props.fileName?.replace('.pdf', '').replace(search_folder_name || '', '').replace(`/${props.id}`, '').replace(/\\/g, '');
  return (
    <p className="text-sm font-semibold text-gray-900">
      {cleaned_file_name}
      <span className="ml-2 text-sm text-gray-500">
        ({props.id})
      </span>
    </p>
  )
}
