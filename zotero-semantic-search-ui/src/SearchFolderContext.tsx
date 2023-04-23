import { createContext, useContext, useState } from 'react';

interface SearchFolderContextValue {
  searchFolder: string | null;
  setSearchFolder: (folder: string | null) => void;
}

const SearchFolderContext = createContext<SearchFolderContextValue>({
  searchFolder: null,
  setSearchFolder: () => {},
});

export const useSearchFolder = () => {
  return useContext(SearchFolderContext);
};

interface SearchFolderProviderProps {
  children: React.ReactNode;
}

export const SearchFolderProvider: React.FC<SearchFolderProviderProps> = ({ children }) => {
  const [searchFolder, setSearchFolder] = useState<string | null>(() => {
    return localStorage.getItem('search_folder');
  });

  const handleSetSearchFolder = (folder: string | null) => {
    setSearchFolder(folder);
    if (folder) {
      localStorage.setItem('search_folder', folder);
    } else {
      localStorage.removeItem('search_folder');
    }
  };

  return (
    <SearchFolderContext.Provider value={{ searchFolder, setSearchFolder: handleSetSearchFolder }}>
      {children}
    </SearchFolderContext.Provider>
  );
};
