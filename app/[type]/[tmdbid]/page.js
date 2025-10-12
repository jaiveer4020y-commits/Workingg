'use client';
import { useEffect, useState } from 'react';
import ReactPlayer from 'react-player';
import Image from 'next/image';

export default function MoviePlayer({ params }) {
  const { type, tmdbid } = params;
  const [videoUrl, setVideoUrl] = useState('');
  const [poster, setPoster] = useState('');
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const TMDB_KEY = 'f1d68bda9a64e7eaa3e4a8f6a1bbf2c8';

  useEffect(() => {
    const getMovie = async () => {
      const res = await fetch(
        `https://api.themoviedb.org/3/movie/${tmdbid}?api_key=${TMDB_KEY}&language=en-US`
      );
      const data = await res.json();
      setTitle(data.title);
      if (data.backdrop_path)
        setPoster(`https://image.tmdb.org/t/p/original${data.backdrop_path}`);
    };
    getMovie();
  }, [tmdbid]);

  useEffect(() => {
    const slug = `tmdb-${tmdbid}`;
    const fetchStream = async (retry = 0) => {
      try {
        const res = await fetch(`https://u-1-1azw.onrender.com/api/get-stream?title=${slug}`);
        const data = await res.json();
        if (data.success && data.m3u8_url) {
          const proxy = `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            data.m3u8_url
          )}`;
          setVideoUrl(proxy);
          setLoading(false);
        } else if (retry < 8) {
          setTimeout(() => fetchStream(retry + 1), 4000);
        } else {
          setError('No stream found.');
          setLoading(false);
        }
      } catch {
        if (retry < 8) setTimeout(() => fetchStream(retry + 1), 4000);
        else {
          setError('Render API failed to respond.');
          setLoading(false);
        }
      }
    };
    fetchStream();
  }, [tmdbid]);

  return (
    <div style={{ background: '#000', minHeight: '100vh', color: '#fff' }}>
      {loading && (
        <div style={{ textAlign: 'center', paddingTop: '20vh' }}>
          {poster && (
            <Image
              src={poster}
              width={480}
              height={270}
              alt="Poster"
              style={{ borderRadius: 10 }}
            />
          )}
          <h3 style={{ color: '#e50914', marginTop: 20 }}>Loading Stream... Please wait 🔄</h3>
        </div>
      )}

      {!loading && videoUrl && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <h2 style={{ color: '#e50914', fontFamily: 'Arial', marginTop: 10 }}>{title}</h2>
          <div style={{ width: '90%', maxWidth: 900, aspectRatio: '16/9' }}>
            <ReactPlayer
              url={videoUrl}
              controls
              playing
              width="100%"
              height="100%"
              config={{
                file: {
                  attributes: { crossOrigin: 'anonymous' },
                  forceHLS: true,
                },
              }}
              style={{
                borderRadius: 10,
                boxShadow: '0 0 25px rgba(229,9,20,0.6)',
                overflow: 'hidden',
              }}
            />
          </div>
        </div>
      )}

      {error && <p style={{ textAlign: 'center', color: 'red' }}>{error}</p>}
    </div>
  );
}
