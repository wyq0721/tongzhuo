import {cpSync,mkdirSync} from 'node:fs';
mkdirSync('dist',{recursive:true});
for(const file of ['index.html','app.js','style.css'])cpSync('public/'+file,'dist/'+file);
console.log('Static bundle ready in dist/; Mac room service remains separate.');
