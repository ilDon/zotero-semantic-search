import React, { createContext, useContext, useState, useEffect } from 'react';
import { Api } from '../modules/api';
import { IndexedDbHelper } from '../modules/indexed-db-helper';

interface PdfTextProviderProps {
  children: React.ReactNode;
}

interface PdfTextContextData {
  sectionText: Record<string, Array<string>>;
  addIds: (ids: Array<string>) => void;
  getSectionText: (id: string) => Array<string> | undefined;
}

const PdfTextContext = createContext<PdfTextContextData | undefined>(undefined);

export const PdfTextProvider: React.FC<PdfTextProviderProps> = ({ children }) => {
  const indexedDbHelper = React.useRef<IndexedDbHelper>(new IndexedDbHelper());
  const [sectionText, setSectionText] = useState<Record<string, Array<string>>>({}); 
  const [idsToFetch, setIdsToFetch] = useState<Array<string>>([]);
  const isFetching = React.useRef(false);
  const addIds = React.useCallback((ids: Array<string>) => {
    if (ids.length > 0) {
      setIdsToFetch((prev) => [...prev, ...ids]);
    }
  }, []);

  const getSectionText = (id: string): Array<string> | undefined => {
    return sectionText[id];
  };

  useEffect(() => {
    const fetchAndSetSectionText = async () => {
      if (idsToFetch.length > 0) {
        const id = idsToFetch.shift() as string;
        if (!sectionText[id]) {
          isFetching.current = true;
    
          let text = await indexedDbHelper.current.getText(id);
    
          if (text === null) {
            text = await new Api().sectionsText(id);
            await indexedDbHelper.current.addText(id, text);
          }
    
          setSectionText((prev) => ({ ...prev, [id]: text as Array<string> }));
        }
        setIdsToFetch((prev) => prev.filter((i) => i !== id));
        isFetching.current = false;
      }
    };
    
    const checkAndFetch = () => {
      if (!isFetching.current) {
        fetchAndSetSectionText();
      } else {
        setTimeout(() => {
          checkAndFetch();
        }, 1000);
      }
    };
    checkAndFetch();
  }, [sectionText, idsToFetch]);

  return (
    <PdfTextContext.Provider value={{ sectionText, addIds: addIds, getSectionText }}>
      {children}
    </PdfTextContext.Provider>
  );
};

export const usePdfText = () => {
  const context = useContext(PdfTextContext);
  if (context === undefined) {
    throw new Error('usePdfText must be used within a PdfTextProvider');
  }
  return context;
};
