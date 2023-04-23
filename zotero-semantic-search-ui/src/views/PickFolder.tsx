import { useNavigate } from 'react-router-dom';
import { SearchFolder } from '../modules/search-folder';

export const PickFolder: React.FC = () => {
  const navigate = useNavigate();

  const handleFolderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const folderPath = files[0].webkitRelativePath.split('/').slice(0, -1).join('/');
      SearchFolder.setSearchFolder(folderPath);
      navigate('/query');
    }
  };

  return (
    <div className="container mx-auto py-5">
      <h1 className="text-3xl mb-5">Select a folder</h1>
      <input type="file" onChange={handleFolderChange} />
    </div>
  );
};
