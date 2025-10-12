'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

// Dynamically import React Player (client-only)
const ReactPlayer = dynamic(() => import('react-player'), { ssr: false });

export default function EpisodePlayer({ params }) {
  const { type, tmdbid, season, episode } = params;

  const [loading, setLoading] = useState(true);
  const [m3u8Url, setM3u8Url] = useState('');
  const [poster, setPoster] = useState('');
  const [error, setError] = useState('');
  const [retryCount, setRetryCount] = useState(0);

  // --- Build slug for your Render API ---
  const slug =
    type === 'movie'
      ? `${tmdbid}` // you can change this to title if available
      : `${tmdbid}.s${season}e${episode}`;

  const renderApiUrl = `https://u-1-1azw.onrender.com/api/get-stream?title=${slug}`;

  // --- TMDB Image Fetch ---
  const fetchPoster = async () => {
    try {
      const res = await fetch(
        `https://api.themoviedb.org/3/${type}/${tmdbid}?api_key=1d4b69f09b9a6fd8fdc32b9ab22c5d65`
      );
      const data = await res.json();
      const img =
        data.poster_path || data.backdrop_path
          ? `https://image.tmdb.org/t/p/original${data.poster_path || data.backdrop_path}`
          : '';
      setPoster(img);
    } catch (err) {
      console.error('TMDB fetch failed:', err);
    }
  };

  // --- Fetch Render API with retry ---
  const fetchStream = async () => {
    try {
      const res = await fetch(renderApiUrl);
      const data = await res.json();

      if (data.success && data.m3u8_url) {
        setM3u8Url(data.m3u8_url);
        setLoading(false);
      } else {
        throw new Error('No valid JSON yet');
      }
    } catch (err) {
      if (retryCount < 10) {
        console.log(`Retrying render fetch... (${retryCount + 1})`);
        setTimeout(() => {
          setRetryCount((c) => c + 1);
          fetchStream();
        }, 5000); // retry every 5 seconds
      } else {
        setError('Server taking too long to wake. Try again later.');
      }
    }
  };

  useEffect(() => {
    fetchPoster();
    fetchStream();
  }, []);

  return (
    <div
      style={{
        width: '100%',
        height: '100vh',
        backgroundColor: '#000',
        backgroundImage: poster ? `url(${poster})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'column',
        color: '#fff',
      }}
    >
      {loading ? (
        <>
          <h2 style={{ background: 'rgba(0,0,0,0.6)', padding: '1rem', borderRadius: '8px' }}>
            Loading stream from Render...
          </h2>
          <p>Retries: {retryCount}</p>
        </>
      ) : error ? (
        <h2>{error}</h2>
      ) : (
        <div style={{ width: '100%', maxWidth: '900px', aspectRatio: '16/9' }}>
          <ReactPlayer
            url={m3u8Url}
            controls
            playing
            width="100%"
            height="100%"
            config={{
              file: {
                attributes: {
                  crossOrigin: 'anonymous',
                },
              },
            }}
          />
        </div>
      )}
    </div>
  );
}
