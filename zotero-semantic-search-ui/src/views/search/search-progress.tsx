import React, { useEffect, useState } from "react";
import { WebSocketHandler } from '../../modules/web-socket-handler';
import { SearchProgressEta } from './search-progress-eta';

interface ISearchProgressProps {
  isSearching: boolean;
}

export const SearchProgress: React.FC<ISearchProgressProps> = (props) => {
  const [progress, setProgress] = useState(0);
  const [expectedEndTime, setExpectedEndTime] = useState<number>(0);
  const [startTime, setStartTime] = useState(0);

  
  useEffect(() => {
    if (props.isSearching) {
      if(progress === 1) {
        setStartTime(Date.now());
      }
    } else {
      setProgress(0);
      setExpectedEndTime(0);
    }
  }, [props.isSearching, progress]);
  
  useEffect(() => {

    const handleProgress = (progress: number) => {
      setProgress(progress);

      if (progress > 10) {
        const currentTime = Date.now();
        const elapsedTime = (currentTime - startTime) / 1000;
        const speed = progress / elapsedTime;
        const remainingTime = (100 - progress) / speed;
        const expectedEndTime = currentTime + (remainingTime * 1000);
        setExpectedEndTime(expectedEndTime);
      }
    }

    const progressWebSocket = new WebSocketHandler(handleProgress);

    return () => {
      progressWebSocket.close();
    };
  }, [startTime]);

  if (!props.isSearching) {
    return null;
  }

  return (
    <div className="flex flex-col items-center justify-center w-full mt-10">
      <p className="text-gray-500 text-sm mb-1">{progress === 0 ? 'Fetching from DB...' : 'Searching...'}</p>
      <div className="relative w-full bg-gray-200 rounded-full dark:bg-gray-700 max-w-[250px] h-4">
        <span className="absolute left-0 top-0.5 w-full h-4 text-center text-xs font-medium text-gray-800 leading-none" style={{ clipPath: `polygon(${progress}% 0, 100% 0, 100% 100%, ${progress}% 100%)` }}>
          {progress > 0 ? `${progress}%` : ''}
        </span>
        <span className="absolute left-0 top-0.5 w-full h-4 text-center text-xs font-medium text-indigo-100 leading-none z-10" style={{ clipPath: `polygon(0 0, ${progress}% 0, ${progress}% 100%, 0% 100%)` }}>
          {progress > 0 ? `${progress}%` : ''}
        </span>
        <div className={`${progress > 0 ? 'bg-indigo-600' : ''} h-4 leading-none rounded-full`} style={{ width: `${progress}%`, position: 'relative' }}></div>
      </div>
      <SearchProgressEta startTime={startTime} expectedEndTime={expectedEndTime} />
    </div>
  );
};