'use client';
import { useEffect, useState } from 'react';

export default function PlayerPage({ params }) {
  const { type, tmdbid, season, episode } = params;
  const [stream, setStream] = useState('');
  const [loading, setLoading] = useState(true);
  const [poster, setPoster] = useState('');

  useEffect(() => {
    async function load() {
      try {
        // Fetch TMDB background
        const tmdbRes = await fetch(
          `https://api.themoviedb.org/3/${type}/${tmdbid}?api_key=YOUR_TMDB_KEY&language=en-US`
        );
        const tmdbData = await tmdbRes.json();
        if (tmdbData.backdrop_path) {
          setPoster(`https://image.tmdb.org/t/p/original${tmdbData.backdrop_path}`);
        }

        // Create slug for your Render API
        const titleSlug = `${tmdbData.title || tmdbData.name}`.toLowerCase().replace(/\s+/g, '.') +
          `.s${season}e${episode}`;

        // Call your own Python backend
        const res = await fetch(`/api/app?title=${encodeURIComponent(titleSlug)}`);
        const json = await res.json();

        if (json.success && json.proxy_url) {
          setStream(json.proxy_url);
        }
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [type, tmdbid, season, episode]);

  return (
    <div style={{
      width: '100vw',
      height: '100vh',
      background: `url(${poster}) center/cover no-repeat`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}>
      {loading ? (
        <div style={{ color: 'white', fontSize: '1.2rem' }}>Loading stream...</div>
      ) : stream ? (
        <video
          controls
          autoPlay
          style={{
            width: '90%',
            height: '80%',
            borderRadius: '10px',
            boxShadow: '0 0 20px rgba(0,0,0,0.7)',
            backgroundColor: 'black'
          }}
        >
          <source src={stream} type="application/x-mpegURL" />
          Your browser does not support HTML5 video.
        </video>
      ) : (
        <div style={{ color: 'white' }}>Failed to load stream.</div>
      )}
    </div>
  );
}
