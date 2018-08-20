import models from '@models'
import musicApi from '@suen/music-api'
import Sequelize from 'sequelize'
import moment from 'moment'
import config from 'config'
import _ from 'lodash'
import { vendor } from '@types'
import redis from '@redis'

export async function updateSongInfo(): Promise<void> {
    const songs = await models.song.findAll()
    // 分类
    const songsList: { [key in Schema.vendor]: Array<Schema.song> } = {
        [vendor.netease]: [],
        [vendor.xiami]: [],
        [vendor.qq]: [],
    }
    songs.forEach((item: Schema.song) => {
        songsList[item.vendor].push(item)
    })
    const doUpdate = async (vendor: vendor, list: Array<Schema.song>) => {
        const ids = list.map(
            item => (vendor === 'qq' && item.commentId && item.commentId !== 'undefined' ? item.commentId : item.songId)
        )
        const data = await musicApi.getBatchSongDetail(vendor, ids)
        if (data.status) {
            const songsObject: {
                [key: string]: musicApi.musicInfo
            } = {}
            data.data.forEach(item => {
                songsObject[item.id.toString()] = item
            })
            // 遍历数据库中的数据
            for (let info of list) {
                // 已存的信息
                const defaultInfo = {
                    commentId: info.commentId + '',
                    name: info.name,
                    artists: info.artists,
                    cp: info.cp,
                }
                const songId = info.commentId && info.commentId !== 'undefined' ? info.commentId : info.songId
                const item = songsObject[songId]
                if (item) {
                    // 待更新的信息
                    const updateInfo = {
                        commentId: item.id + '',
                        name: item.name,
                        artists: item.artists,
                        cp: item.cp,
                    }
                    // 比对是否相等
                    if (!_.isEqual(updateInfo, defaultInfo)) {
                        try {
                            await models.song.update(updateInfo, {
                                where: {
                                    id: info.id,
                                },
                            })
                            console.log('update success: %s', info.name)
                        } catch (e) {
                            console.error('update fail: %s', info.name)
                        }
                    }
                } else {
                    // 歌曲信息不存在 代表音乐平台把歌曲删了
                    console.log(info.vendor, info.name, info.songId)
                    if (!info.cp) {
                        try {
                            await models.song.update(
                                {
                                    cp: true,
                                },
                                {
                                    where: {
                                        id: info.id,
                                    },
                                }
                            )
                            console.log('update success: %s', info.name)
                        } catch (e) {
                            console.error('update fail: %s', info.name)
                        }
                    }
                }
            }
        } else {
            console.error('getDetail fail: %s', vendor)
        }
    }
    for (let key of Object.keys(songsList)) {
        const _key = key as vendor
        const list = songsList[_key]
        if (_key === vendor.qq) {
            let arr: Array<Schema.song> = []
            for (let index = 0; index < list.length; index++) {
                arr.push(list[index])
                if (arr.length === 50 || index + 1 === list.length) {
                    // 每50首更新一次
                    await doUpdate(_key, arr)
                    arr = []
                }
            }
        } else {
            await doUpdate(_key, list)
        }
    }
    console.log('updateSongInfo down')
}

export async function updateQQCommentId(): Promise<void> {
    const songs = await models.song.findAll({
        where: {
            vendor: 'qq',
        },
    })
    // 挨个更新
    for (let item of songs) {
        const info = await musicApi.qq.getSongDetail(item.songId, false, 'songmid')
        await new Promise(resolve => {
            setTimeout(() => {
                resolve()
            }, 500)
        })
        if (!info.status) {
            console.log('cannot get info: ', item.name, item.songId)
            continue
        }
        await models.song.update(
            {
                commentId: info.data.id,
            },
            {
                where: {
                    id: item.id,
                },
            }
        )
        console.log('update success: ', item.name)
    }
}

export async function move(): Promise<void> {
    const last = new Sequelize(config.get('oldSequelize'))
    const next = new Sequelize(config.get('sequelize'))

    const transferUser = async () => {
        const [results] = await last.query('SELECT * from `users`')
        for (let info of results) {
            const values = {
                '`id`': info.id,
                '`sn`': `'${info.sn}'`,
                '`nickname`': `'${info.nickname}'`,
                '`avatar`': `'${info.avatar}'`,
                '`sourceData`': `'${JSON.stringify(info.sourceData)}'`,
                '`from`': `'${info.from}'`,
                '`createdAt`': `'${moment(info.createdAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                '`updatedAt`': `'${moment(info.updatedAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                '`unionid`': `'${info.unionid}'`,
            }
            const sql = `INSERT INTO \`user\` (${Object.keys(values).join(',')}) VALUES(${Object.values(values)
                .join(',')
                .replace(/[\\]/g, '\\\\')})`
            try {
                await next.query(sql)
            } catch (e) {}
        }
    }
    const transferPlaylist = async () => {
        const [results] = await last.query('SELECT * from `playlists`')
        for (let info of results) {
            const values = {
                '`id`': info.id,
                '`name`': `'${info.name}'`,
                '`user_id`': info.user_id,
                '`createdAt`': `'${moment(info.createdAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                '`updatedAt`': `'${moment(info.updatedAt).format('YYYY-MM-DD HH:mm:ss')}'`,
            }
            const sql = `INSERT INTO \`playlist\` (${Object.keys(values).join(',')}) VALUES(${Object.values(values)
                .join(',')
                .replace(/[\\]/g, '\\\\')})`
            try {
                await next.query(sql)
            } catch (e) {
                // console.warn(e)
            }
        }
    }
    const transferPlaylist_song = async () => {
        const [results] = await last.query('SELECT * from `song_playlists`')
        for (let info of results) {
            if (info.vendor === 'qq') {
                const data = await musicApi.getSongDetail(vendor.qq, info.song_id)
                if (!data.status) continue
                info.commentId = data.data.commentId
            }
            if (info.sourceData) {
                const songValues = {
                    '`songId`': `'${info.song_id}'`,
                    '`vendor`': `'${info.vendor}'`,
                    '`commentId`': `'${info.commentId}'`,
                    '`name`': `'${info.sourceData.name}'`,
                    '`album`': `'${JSON.stringify(info.sourceData.album)}'`,
                    '`artists`': `'${JSON.stringify(info.sourceData.artists)}'`,
                    '`cp`': info.sourceData.cp,
                    '`createdAt`': `'${moment(info.createdAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                    '`updatedAt`': `'${moment(info.updatedAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                }
                const songSql = `INSERT INTO \`song\` (${Object.keys(songValues).join(',')}) VALUES(${Object.values(
                    songValues
                )
                    .join(',')
                    .replace(/[\\]/g, '\\\\')})`

                let song_id
                try {
                    const data = await next.query(songSql)
                    song_id = data[0]
                } catch (e) {
                    // console.warn(e)
                }
                try {
                    const playlist_songValues = {
                        '`song_id`': song_id,
                        '`playlist_id`': info.playlist_id,
                        '`createdAt`': `'${moment(info.createdAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                        '`updatedAt`': `'${moment(info.updatedAt).format('YYYY-MM-DD HH:mm:ss')}'`,
                    }
                    const playlist_songSql = `INSERT INTO \`playlist_song\` (${Object.keys(playlist_songValues).join(
                        ','
                    )}) VALUES(${Object.values(playlist_songValues)
                        .join(',')
                        .replace(/[\\]/g, '\\\\')})`
                    await next.query(playlist_songSql)
                } catch (e) {
                    // console.warn(e)
                }
            }
        }
    }
    await transferUser()
    console.log('transferUser down')
    await transferPlaylist()
    console.log('transferPlaylist down')
    await transferPlaylist_song()
    console.log('transferPlaylist_song down')
}

export async function getNeteaseRank(): Promise<void> {
    for (let i = 0; i <= 21; i++) {
        const data = await musicApi.netease.getTopList(i.toString())
        if (data.status) {
            redis.set(`netease-rank-${i}`, JSON.stringify(data.data))
        } else {
            console.log(`获取网易云排行榜失败：${i}, ${JSON.stringify(data)}`)
        }
    }
}
