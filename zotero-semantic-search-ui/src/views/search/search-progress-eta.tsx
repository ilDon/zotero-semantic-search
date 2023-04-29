import * as React from 'react';

interface ISearchProgressEtaProps {
  startTime: number;
  expectedEndTime: number;
}

const convertSecondsToTime = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds - (hours * 3600)) / 60);
  const remainingSeconds = Math.round(seconds - (hours * 3600) - (minutes * 60));
  const hoursString = hours < 10 ? `0${hours}` : `${hours}`;
  const minutesString = minutes < 10 ? `0${minutes}` : `${minutes}`;
  const secondsString = remainingSeconds < 10 ? `0${remainingSeconds}` : `${remainingSeconds}`;
  const infos = [];
  if (hours > 0) {
    infos.push(hoursString);
  }
  infos.push(minutesString);
  infos.push(secondsString);
  return infos.join(':');
};

export const SearchProgressEta: React.FC<ISearchProgressEtaProps> = (props) => {
  const [currentTime, setCurrentTime] = React.useState(Date.now());

  React.useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const remainingTime = Math.round((props.expectedEndTime - currentTime) / 1000);

  if (remainingTime < 0) {
    return null;
  }

  return (
    <p className="text-gray-500 mt-2 text-sm">ETA: {convertSecondsToTime(remainingTime)}</p>
  );
};
