import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { SearchFolder } from '../../modules/search-folder';

export const PickFolder: React.FC = () => {
  const [folderPath, setFolderPath] = React.useState('');
  const navigate = useNavigate();

  const handleFolderChange = () => {
    SearchFolder.setSearchFolder(folderPath);
    navigate('/query');
  };

  const onEnterDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter') {
      handleFolderChange();
    }
  };

  return (
    <div className="container mx-auto py-5">
      <label htmlFor="username" className="block text-sm font-medium leading-6 text-gray-900">
        Full path to the folder
      </label>
      <div className="mt-2">
        <div className="flex rounded-md shadow-sm ring-1 ring-inset ring-gray-300 focus-within:ring-2 focus-within:ring-inset focus-within:ring-indigo-600 sm:max-w-md">
          <input
            type="text"
            name="folderPath"
            id="folderPath"
            autoComplete="off"
            className="block flex-1 border-0 bg-transparent py-1.5 pl-1 text-gray-900 placeholder:text-gray-400 focus:ring-0 sm:text-sm sm:leading-6"
            placeholder="Folder Path"
            onChange={(e) => setFolderPath(e.target.value)}
            value={folderPath}
            onKeyDown={onEnterDown}
          />
        </div>
      </div>
      <div className="mt-2">
        <button
          type="button"
          className="rounded-md bg-indigo-600 px-2.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600"
          onClick={handleFolderChange}
        >
          Save
        </button>
      </div>
    </div>
  );
};
